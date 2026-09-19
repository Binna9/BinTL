use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::{InitArgsBuilder, JNIEnv, JNIVersion, JavaVM};
use storage::LiveConnection;

use crate::ConnectError;

const LOGIN_TIMEOUT_SEC: i32 = 8;
const JAR_NAME: &str = "tbjdbc17-7.2.6.jar";
const MAVEN_JAR_URL: &str =
    "https://repo1.maven.org/maven2/com/tmaxtibero/tbjdbc17/7.2.6/tbjdbc17-7.2.6.jar";

static JVM: OnceLock<JavaVM> = OnceLock::new();

pub(crate) struct JdbcConn {
    inner: Option<GlobalRef>,
}

impl Drop for JdbcConn {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else {
            return;
        };
        let Some(vm) = JVM.get() else {
            return;
        };
        let Ok(mut env) = vm.attach_current_thread() else {
            return;
        };
        let _ = env.call_method(&inner, "close", "()V", &[]);
        let _ = env.exception_clear();
        drop(inner);
    }
}

impl From<jni::errors::Error> for ConnectError {
    fn from(error: jni::errors::Error) -> Self {
        ConnectError::Invalid(error.to_string())
    }
}

pub(crate) fn jdbc_url(c: &LiveConnection) -> String {
    let db = if c.database.trim().is_empty() {
        "tibero"
    } else {
        c.database.trim()
    };
    format!("jdbc:tibero:thin:@{}:{}:{db}", c.host.trim(), c.port)
}

pub(crate) fn open(c: &LiveConnection) -> Result<JdbcConn, ConnectError> {
    let jar = ensure_jar()?;
    let vm = jvm(&jar)?;
    let mut env = vm.attach_current_thread()?;
    load_driver(&mut env)?;
    let timeout = env.call_static_method(
        "java/sql/DriverManager",
        "setLoginTimeout",
        "(I)V",
        &[JValue::Int(LOGIN_TIMEOUT_SEC)],
    );
    step(&mut env, timeout)?;
    let url = env.new_string(jdbc_url(c))?;
    let user = env.new_string(&c.username)?;
    let password = env.new_string(&c.password)?;
    let conn = env.call_static_method(
        "java/sql/DriverManager",
        "getConnection",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/sql/Connection;",
        &[
            JValue::Object(&url),
            JValue::Object(&user),
            JValue::Object(&password),
        ],
    );
    let conn = step(&mut env, conn)?;
    Ok(JdbcConn {
        inner: Some(env.new_global_ref(conn.l()?)?),
    })
}

pub(crate) fn query_rows(
    conn: &JdbcConn,
    sql: &str,
) -> Result<(Vec<String>, Vec<Vec<String>>), ConnectError> {
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    stream_query(
        conn,
        sql,
        |names| {
            columns = names.to_vec();
            Ok(())
        },
        |row| {
            rows.push(row.to_vec());
            Ok(())
        },
    )?;
    Ok((columns, rows))
}

pub(crate) fn exec(conn: &JdbcConn, sql: &str) -> Result<u64, ConnectError> {
    let mut env = attach()?;
    let sql_j = env.new_string(sql)?;
    let stmt = env
        .call_method(
            handle(conn)?,
            "createStatement",
            "()Ljava/sql/Statement;",
            &[],
        )?
        .l()?;
    check_ex(&mut env)?;
    let has_rs = env
        .call_method(
            &stmt,
            "execute",
            "(Ljava/lang/String;)Z",
            &[JValue::Object(&sql_j)],
        )?
        .z()?;
    check_ex(&mut env)?;
    let n = if has_rs {
        0
    } else {
        env.call_method(&stmt, "getUpdateCount", "()I", &[])?
            .i()?
            .max(0) as u64
    };
    close_stmt(&mut env, &stmt);
    Ok(n)
}

pub(crate) fn stream_query(
    conn: &JdbcConn,
    sql: &str,
    mut on_columns: impl FnMut(&[String]) -> Result<(), ConnectError>,
    mut on_row: impl FnMut(&[String]) -> Result<(), ConnectError>,
) -> Result<u64, ConnectError> {
    let mut env = attach()?;
    let sql_j = env.new_string(sql)?;
    let stmt = env
        .call_method(
            handle(conn)?,
            "createStatement",
            "()Ljava/sql/Statement;",
            &[],
        )?
        .l()?;
    check_ex(&mut env)?;
    let rs = env.call_method(
        &stmt,
        "executeQuery",
        "(Ljava/lang/String;)Ljava/sql/ResultSet;",
        &[JValue::Object(&sql_j)],
    );
    let rs = step(&mut env, rs)?.l()?;
    check_ex(&mut env)?;
    let meta = env
        .call_method(&rs, "getMetaData", "()Ljava/sql/ResultSetMetaData;", &[])?
        .l()?;
    check_ex(&mut env)?;
    let ncols = env.call_method(&meta, "getColumnCount", "()I", &[])?.i()?;
    let mut columns = Vec::with_capacity(ncols.max(0) as usize);
    for i in 1..=ncols {
        let label = env
            .call_method(
                &meta,
                "getColumnLabel",
                "(I)Ljava/lang/String;",
                &[JValue::Int(i)],
            )?
            .l()?;
        columns.push(java_string(&mut env, label));
    }
    on_columns(&columns)?;
    let mut n = 0u64;
    loop {
        let next = env.call_method(&rs, "next", "()Z", &[])?.z()?;
        check_ex(&mut env)?;
        if !next {
            break;
        }
        let mut row = Vec::with_capacity(columns.len());
        for i in 1..=ncols {
            let value = env
                .call_method(&rs, "getString", "(I)Ljava/lang/String;", &[JValue::Int(i)])?
                .l()?;
            row.push(java_string(&mut env, value));
        }
        on_row(&row)?;
        n += 1;
    }
    let _ = env.call_method(&rs, "close", "()V", &[]);
    close_stmt(&mut env, &stmt);
    Ok(n)
}

pub(crate) fn schemas(conn: &JdbcConn) -> Result<Vec<String>, ConnectError> {
    let mut names = Vec::new();
    if let Ok((_, rows)) = query_rows(conn, "SELECT USER FROM DUAL") {
        names.extend(rows.into_iter().filter_map(|row| row.into_iter().next()));
    }
    let mut env = attach()?;
    let meta = db_meta(&mut env, conn)?;
    let rs = env.call_method(&meta, "getSchemas", "()Ljava/sql/ResultSet;", &[]);
    if let Ok(rs) = step(&mut env, rs) {
        let rs = rs.l()?;
        names.extend(read_strings(&mut env, &rs, 1)?);
        close_rs(&mut env, &rs);
    }
    if let Ok(tables) = get_tables(&mut env, &meta, None) {
        names.extend(tables.into_iter().map(|(owner, _, _)| owner));
    }
    Ok(unique_keep_order(names))
}

fn unique_keep_order(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .into_iter()
        .filter(|name| {
            let key = name.to_ascii_uppercase();
            !key.is_empty() && seen.insert(key)
        })
        .collect()
}

pub(crate) fn relations(
    conn: &JdbcConn,
    schema: &str,
) -> Result<Vec<(String, String)>, ConnectError> {
    let mut env = attach()?;
    let meta = db_meta(&mut env, conn)?;
    let mut rows = get_tables(&mut env, &meta, Some(schema))?;
    if rows.is_empty() {
        rows = get_tables(&mut env, &meta, None)?;
        rows.retain(|(owner, _, _)| owner.eq_ignore_ascii_case(schema) || owner.is_empty());
    }
    Ok(rows
        .into_iter()
        .filter_map(|(_, name, kind)| {
            if name.is_empty() {
                return None;
            }
            let kind = if kind.to_ascii_uppercase().contains("VIEW") {
                "view".to_string()
            } else {
                "table".to_string()
            };
            Some((name, kind))
        })
        .collect())
}

pub(crate) struct JdbcColumn {
    pub ordinal: i32,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub max_length: Option<i64>,
    pub numeric_scale: Option<i64>,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

pub(crate) fn columns(
    conn: &JdbcConn,
    schema: &str,
    table: &str,
) -> Result<Vec<JdbcColumn>, ConnectError> {
    let owner = crate::sql_lit(schema);
    let name = crate::sql_lit(table);
    let typed = "CASE
          WHEN c.DATA_TYPE IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW')
               AND c.DATA_LENGTH IS NOT NULL
            THEN c.DATA_TYPE || '(' || c.DATA_LENGTH || ')'
          WHEN c.DATA_TYPE = 'NUMBER' AND c.DATA_PRECISION IS NOT NULL
            THEN c.DATA_TYPE || '(' || c.DATA_PRECISION || ',' || NVL(c.DATA_SCALE, 0) || ')'
          ELSE c.DATA_TYPE
        END";
    let dict = |prefix: &str, default_expr: &str| {
        format!(
            "SELECT c.COLUMN_ID, c.COLUMN_NAME, {typed}, c.NULLABLE, {default_expr}, c.DATA_LENGTH, c.DATA_SCALE, cc.COMMENTS
             FROM {prefix}ALL_TAB_COLUMNS c
             LEFT JOIN {prefix}ALL_COL_COMMENTS cc
               ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
             WHERE c.OWNER = {owner} AND c.TABLE_NAME = {name}
             ORDER BY c.COLUMN_ID"
        )
    };
    let queries = [
        dict("SYS.", "c.DATA_DEFAULT"),
        dict("", "c.DATA_DEFAULT"),
        dict("SYS.", "NULL"),
        dict("", "NULL"),
        format!(
            "SELECT c.COLUMN_ID, c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, NULL, c.DATA_LENGTH, c.DATA_SCALE, cc.COMMENTS
             FROM USER_TAB_COLUMNS c
             LEFT JOIN USER_COL_COMMENTS cc ON cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
             WHERE c.TABLE_NAME = {name}
             ORDER BY c.COLUMN_ID"
        ),
    ];
    for sql in &queries {
        if let Ok((_, rows)) = query_rows(conn, sql) {
            if !rows.is_empty() {
                return Ok(rows.into_iter().filter_map(col_from_dict).collect());
            }
        }
    }
    jdbc_get_columns(conn, schema, table)
}

fn col_from_dict(row: Vec<String>) -> Option<JdbcColumn> {
    let get = |i: usize| row.get(i).cloned().unwrap_or_default();
    let name = get(1);
    if name.trim().is_empty() {
        return None;
    }
    let comment = get(7);
    let default_value = get(4);
    Some(JdbcColumn {
        ordinal: get(0).parse().unwrap_or(0),
        name,
        data_type: get(2),
        nullable: !get(3).eq_ignore_ascii_case("N"),
        max_length: get(5).parse().ok(),
        numeric_scale: get(6).parse().ok(),
        default_value: nonempty_cell(&default_value),
        comment: nonempty_cell(&comment),
    })
}

fn nonempty_cell(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn jdbc_get_columns(
    conn: &JdbcConn,
    schema: &str,
    table: &str,
) -> Result<Vec<JdbcColumn>, ConnectError> {
    let mut env = attach()?;
    let meta = db_meta(&mut env, conn)?;
    let catalog = JObject::null();
    let schema_j = env.new_string(schema)?;
    let table_j = env.new_string(table)?;
    let pct = env.new_string("%")?;
    let rs = env.call_method(
        &meta,
        "getColumns",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/sql/ResultSet;",
        &[
            JValue::Object(&catalog),
            JValue::Object(&schema_j),
            JValue::Object(&table_j),
            JValue::Object(&pct),
        ],
    );
    let Ok(rs) = step(&mut env, rs) else {
        return Ok(Vec::new());
    };
    let rs = rs.l()?;
    let mut out = Vec::new();
    loop {
        let next = env.call_method(&rs, "next", "()Z", &[])?.z()?;
        check_ex(&mut env)?;
        if !next {
            break;
        }
        let name = rs_string(&mut env, &rs, 4)?;
        if name.is_empty() {
            continue;
        }
        let data_type = rs_string(&mut env, &rs, 6)?;
        let size = rs_i64(&mut env, &rs, 7);
        let scale = rs_i64(&mut env, &rs, 9);
        let nullable = rs_i64(&mut env, &rs, 11).unwrap_or(1) != 0;
        let ordinal = rs_i64(&mut env, &rs, 17).unwrap_or(0) as i32;
        let comment = rs_string(&mut env, &rs, 12)?;
        let default_value = rs_string(&mut env, &rs, 13)?;
        out.push(JdbcColumn {
            ordinal,
            name,
            data_type,
            nullable,
            max_length: size,
            numeric_scale: scale,
            default_value: nonempty_cell(&default_value),
            comment: nonempty_cell(&comment),
        });
    }
    close_rs(&mut env, &rs);
    Ok(out)
}

fn db_meta<'a>(env: &mut JNIEnv<'a>, conn: &JdbcConn) -> Result<JObject<'a>, ConnectError> {
    let meta = env.call_method(
        handle(conn)?,
        "getMetaData",
        "()Ljava/sql/DatabaseMetaData;",
        &[],
    );
    Ok(step(env, meta)?.l()?)
}

fn get_tables(
    env: &mut JNIEnv,
    meta: &JObject,
    schema: Option<&str>,
) -> Result<Vec<(String, String, String)>, ConnectError> {
    let catalog = JObject::null();
    let schema_j = match schema {
        Some(schema) => env.new_string(schema)?,
        None => JString::from(JObject::null()),
    };
    let pct = env.new_string("%")?;
    let types = env.new_object_array(2, "java/lang/String", JObject::null())?;
    let table = env.new_string("TABLE")?;
    let view = env.new_string("VIEW")?;
    env.set_object_array_element(&types, 0, &table)?;
    env.set_object_array_element(&types, 1, &view)?;
    let rs = env.call_method(
        meta,
        "getTables",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;)Ljava/sql/ResultSet;",
        &[
            JValue::Object(&catalog),
            JValue::Object(&schema_j),
            JValue::Object(&pct),
            JValue::Object(&types),
        ],
    );
    let Ok(rs) = step(env, rs) else {
        return Ok(Vec::new());
    };
    let rs = rs.l()?;
    let mut rows = Vec::new();
    loop {
        let next = env.call_method(&rs, "next", "()Z", &[])?.z()?;
        check_ex(env)?;
        if !next {
            break;
        }
        rows.push((
            rs_string(env, &rs, 2)?.trim().to_string(),
            rs_string(env, &rs, 3)?.trim().to_string(),
            rs_string(env, &rs, 4)?,
        ));
    }
    close_rs(env, &rs);
    Ok(rows)
}

fn read_strings(env: &mut JNIEnv, rs: &JObject, col: i32) -> Result<Vec<String>, ConnectError> {
    let mut names = Vec::new();
    loop {
        let next = env.call_method(rs, "next", "()Z", &[])?.z()?;
        check_ex(env)?;
        if !next {
            break;
        }
        let name = rs_string(env, rs, col)?.trim().to_string();
        if !name.is_empty() {
            names.push(name);
        }
    }
    Ok(names)
}

fn rs_string(env: &mut JNIEnv, rs: &JObject, col: i32) -> Result<String, ConnectError> {
    let value = env.call_method(
        rs,
        "getString",
        "(I)Ljava/lang/String;",
        &[JValue::Int(col)],
    )?;
    check_ex(env)?;
    Ok(java_string(env, value.l()?))
}

fn rs_i64(env: &mut JNIEnv, rs: &JObject, col: i32) -> Option<i64> {
    let value = env
        .call_method(rs, "getLong", "(I)J", &[JValue::Int(col)])
        .ok()?
        .j()
        .ok()?;
    let was_null = env.call_method(rs, "wasNull", "()Z", &[]).ok()?.z().ok()?;
    if was_null {
        None
    } else {
        Some(value)
    }
}

fn close_rs(env: &mut JNIEnv, rs: &JObject) {
    let _ = env.call_method(rs, "close", "()V", &[]);
    let _ = env.exception_clear();
}

fn handle(conn: &JdbcConn) -> Result<&GlobalRef, ConnectError> {
    conn.inner
        .as_ref()
        .ok_or_else(|| ConnectError::Invalid("jdbc connection closed".into()))
}

fn close_stmt(env: &mut JNIEnv, stmt: &JObject) {
    let _ = env.call_method(stmt, "close", "()V", &[]);
    let _ = env.exception_clear();
}

fn attach() -> Result<jni::AttachGuard<'static>, ConnectError> {
    Ok(JVM
        .get()
        .ok_or_else(|| ConnectError::Invalid("jvm not started".into()))?
        .attach_current_thread()?)
}

fn jvm_classpath(jar: &Path) -> String {
    // Windows canonicalize() yields `\\?\C:\...`. Java class.path ignores that prefix,
    // so TbDriver is missing even when the jar file exists.
    let raw = jar.to_string_lossy();
    let stripped = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(raw.as_ref());
    stripped.replace('\\', "/")
}

fn jvm(jar: &Path) -> Result<&'static JavaVM, ConnectError> {
    if let Some(vm) = JVM.get() {
        return Ok(vm);
    }
    ensure_java_home();
    let classpath = jvm_classpath(jar);
    let args = InitArgsBuilder::new()
        .version(JNIVersion::V8)
        .option(format!("-Djava.class.path={classpath}"))
        .build()
        .map_err(|error| ConnectError::Invalid(error.to_string()))?;
    let vm = JavaVM::new(args).map_err(|error| {
        ConnectError::Invalid(format!(
            "failed to start JVM ({error}). Set JAVA_HOME to a JDK (macOS Homebrew: openjdk@17)."
        ))
    })?;
    let _ = JVM.set(vm);
    JVM.get()
        .ok_or_else(|| ConnectError::Invalid("jvm init failed".into()))
}

fn load_driver(env: &mut JNIEnv) -> Result<(), ConnectError> {
    // Tokio worker threads have a null context ClassLoader, so DriverManager SPI finds nothing.
    let thread = env.call_static_method(
        "java/lang/Thread",
        "currentThread",
        "()Ljava/lang/Thread;",
        &[],
    );
    let thread = step(env, thread)?.l()?;
    let loader = env.call_static_method(
        "java/lang/ClassLoader",
        "getSystemClassLoader",
        "()Ljava/lang/ClassLoader;",
        &[],
    );
    let loader = step(env, loader)?.l()?;
    let set_cl = env.call_method(
        &thread,
        "setContextClassLoader",
        "(Ljava/lang/ClassLoader;)V",
        &[JValue::Object(&loader)],
    );
    step(env, set_cl)?;
    let class = env.find_class("com/tmax/tibero/jdbc/TbDriver")?;
    check_ex(env)?;
    let driver = env.new_object(&class, "()V", &[])?;
    check_ex(env)?;
    match env.call_static_method(
        "java/sql/DriverManager",
        "registerDriver",
        "(Ljava/sql/Driver;)V",
        &[JValue::Object(&driver)],
    ) {
        Ok(_) => check_ex(env),
        Err(_) => {
            let _ = env.exception_clear();
            Ok(())
        }
    }
}

fn step<T>(env: &mut JNIEnv, result: Result<T, jni::errors::Error>) -> Result<T, ConnectError> {
    if let Err(error) = check_ex(env) {
        return Err(error);
    }
    result.map_err(Into::into)
}

fn check_ex(env: &mut JNIEnv) -> Result<(), ConnectError> {
    if !env.exception_check()? {
        return Ok(());
    }
    let thrown = env.exception_occurred()?;
    env.exception_clear()?;
    let message = env
        .call_method(&thrown, "toString", "()Ljava/lang/String;", &[])
        .ok()
        .and_then(|value| value.l().ok())
        .map(|obj| java_string(env, obj))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "jdbc exception".into());
    Err(ConnectError::Invalid(message))
}

fn java_string(env: &mut JNIEnv, obj: JObject) -> String {
    if obj.is_null() {
        return String::new();
    }
    env.get_string(&JString::from(obj))
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn ensure_java_home() {
    // Windows keeps a system JAVA_HOME=jdk-8 for other tools; Tibero JDBC needs 17.
    #[cfg(windows)]
    {
        const WIN_JDK17: &str = r"C:\Users\dndql\Desktop\Business\jdk-17";
        if has_jvm(Path::new(WIN_JDK17)) {
            // SAFETY: first Tibero JDBC connect, before other JNI.
            unsafe { std::env::set_var("JAVA_HOME", WIN_JDK17) };
            return;
        }
    }
    if std::env::var_os("JAVA_HOME").is_some_and(|value| !value.is_empty()) {
        return;
    }
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
        "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
        "/usr/libexec/java_home",
    ];
    for candidate in CANDIDATES {
        if *candidate == "/usr/libexec/java_home" {
            continue;
        }
        if has_jvm(Path::new(candidate)) {
            // SAFETY: first Tibero JDBC connect, before other JNI.
            unsafe { std::env::set_var("JAVA_HOME", candidate) };
            return;
        }
    }
    if let Ok(output) = std::process::Command::new("/usr/libexec/java_home").output() {
        if output.status.success() {
            let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !home.is_empty() {
                unsafe { std::env::set_var("JAVA_HOME", home) };
            }
        }
    }
}

fn has_jvm(home: &Path) -> bool {
    home.join("lib/server/libjvm.dylib").exists()
        || home.join("lib/server/libjvm.so").exists()
        || home.join("bin/server/jvm.dll").exists()
}

fn ensure_jar() -> Result<PathBuf, ConnectError> {
    if let Some(path) = nonempty_env("BINTL_TIBERO_JDBC_JAR") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(std::fs::canonicalize(&path).unwrap_or(path));
        }
        return Err(ConnectError::Invalid(format!(
            "BINTL_TIBERO_JDBC_JAR not found: {}",
            path.display()
        )));
    }
    if let Some(path) = crate::oracle::configured_tibero_jdbc() {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(std::fs::canonicalize(&path).unwrap_or(path));
        }
        if path.is_absolute() {
            download(&path)?;
            return Ok(std::fs::canonicalize(&path).unwrap_or(path));
        }
        let relative = PathBuf::from(&path);
        if relative.is_file() {
            return Ok(std::fs::canonicalize(&relative).unwrap_or(relative));
        }
    }
    for path in jar_candidates() {
        if path.is_file() {
            return Ok(std::fs::canonicalize(&path).unwrap_or(path));
        }
    }
    let dest = default_jar_path();
    download(&dest)?;
    Ok(std::fs::canonicalize(&dest).unwrap_or(dest))
}

fn jar_dir() -> PathBuf {
    workspace_dir().join("crates/connectors/vendor/tibero")
}

fn jar_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let dir = jar_dir();
    out.push(dir.join(JAR_NAME));
    out.push(dir.join("tibero6-jdbc.jar"));
    out.push(dir.join("tibero7-jdbc.jar"));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            out.push(parent.join("vendor/tibero").join(JAR_NAME));
        }
    }
    if let Ok(home) = std::env::var("TB_HOME") {
        let home = PathBuf::from(home);
        out.push(home.join("client/lib/jar").join(JAR_NAME));
        out.push(home.join("client/lib/jar/tibero6-jdbc.jar"));
        out.push(home.join("client/lib/jar/tibero7-jdbc.jar"));
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jar") {
                out.push(path);
            }
        }
    }
    out
}

fn default_jar_path() -> PathBuf {
    jar_dir().join(JAR_NAME)
}

fn download(dest: &Path) -> Result<(), ConnectError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ConnectError::Invalid(e.to_string()))?;
    }
    let status = std::process::Command::new("curl")
        .args(["-fsSL", "--retry", "2", "-o"])
        .arg(dest)
        .arg(MAVEN_JAR_URL)
        .status()
        .map_err(|e| ConnectError::Invalid(format!("download Tibero JDBC: {e}")))?;
    if !status.success() || !dest.is_file() {
        let _ = std::fs::remove_file(dest);
        return Err(ConnectError::Invalid(format!(
            "failed to download Tibero JDBC jar from {MAVEN_JAR_URL}"
        )));
    }
    Ok(())
}

fn workspace_dir() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let start = dir.clone();
    for _ in 0..6 {
        if dir.join("crates/connectors").is_dir() {
            return dir;
        }
        if !dir.pop() {
            break;
        }
    }
    start
}

fn nonempty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_sid_url() {
        let c = LiveConnection {
            http_auth: None,
            id: "t".into(),
            name: "t".into(),
            driver: "tibero".into(),
            host: "100.64.0.7".into(),
            port: 8629,
            database: "tibero".into(),
            username: "sys".into(),
            password: "x".into(),
            ssl: false,
        };
        assert_eq!(jdbc_url(&c), "jdbc:tibero:thin:@100.64.0.7:8629:tibero");
    }

    #[test]
    fn empty_database_defaults_sid() {
        let c = LiveConnection {
            http_auth: None,
            id: "t".into(),
            name: "t".into(),
            driver: "tibero".into(),
            host: "db".into(),
            port: 8629,
            database: "  ".into(),
            username: "u".into(),
            password: "p".into(),
            ssl: false,
        };
        assert_eq!(jdbc_url(&c), "jdbc:tibero:thin:@db:8629:tibero");
    }

    #[test]
    fn strips_windows_verbatim_prefix_for_jvm() {
        let jar = PathBuf::from(
            r"\\?\C:\Users\dndql\Desktop\Business\BinTL\crates\connectors\vendor\tibero\tbjdbc17-7.2.6.jar",
        );
        assert_eq!(
            jvm_classpath(&jar),
            "C:/Users/dndql/Desktop/Business/BinTL/crates/connectors/vendor/tibero/tbjdbc17-7.2.6.jar"
        );
    }

    #[test]
    fn loads_jdbc_driver() {
        ensure_java_home();
        if std::env::var_os("JAVA_HOME").is_none() {
            return;
        }
        let jar = ensure_jar().expect("tibero jdbc jar");
        let vm = jvm(&jar).expect("jvm");
        let mut env = vm.attach_current_thread().expect("attach");
        load_driver(&mut env).expect("TbDriver");
    }
}
