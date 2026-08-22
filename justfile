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
    cargo run -p {{pkg}} -- --config config.example.toml

test:
    cargo test --workspace
