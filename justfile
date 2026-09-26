set shell := ["bash", "-eu", "-c"]

pkg := "bintl"

ui:
    bash scripts/build-ui.sh

build: ui
    cargo build --release -p {{pkg}}

build-target TARGET:
    bash scripts/build-target.sh {{TARGET}}

dist TARGET:
    bash scripts/build-target.sh {{TARGET}}

run: ui
    test -f config.toml || cp config.example.toml config.toml
    cargo run -p {{pkg}} -- --config config.toml

test:
    cargo test --workspace

cursor-env:
    command -v openwiki >/dev/null || npm i -g openwiki
    openwiki integrations install cursor --project .
