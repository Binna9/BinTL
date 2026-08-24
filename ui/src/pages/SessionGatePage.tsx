import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { FormField } from "@/components/FormField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { BrandMark } from "@/components/BrandMark";
import { authApi } from "@/services/authApi";

export function SessionGatePage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await authApi.login(username, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen grid-cols-[minmax(20rem,32rem)_1fr] bg-workspace">
      <section className="flex flex-col justify-between border-r border-border bg-surface p-10">
        <BrandMark />

        <div className="max-w-80">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
            데이터 플랫폼
          </p>
          <h1 className="text-xl font-semibold tracking-[-0.015em]">콘솔 로그인</h1>
          <p className="mt-2 text-[13px] leading-5 text-text-secondary">
            데이터 추출, 변환 및 적재 작업을 관리하려면 인증 정보를 입력하세요.
          </p>
          <form className="mt-7 flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
            <FormField label="사용자 이름">
              <input
                className="field-control"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
            </FormField>
            <FormField label="비밀번호">
              <input
                className="field-control"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </FormField>
            {error ? <NoticeBanner>{error}</NoticeBanner> : null}
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "인증 중…" : "로그인"}
            </Button>
          </form>
        </div>

        <p className="text-xs text-text-tertiary">BinTL Enterprise Data Workspace</p>
      </section>
      <div className="bg-workspace" />
    </main>
  );
}
