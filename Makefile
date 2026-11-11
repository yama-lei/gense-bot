# Common commands. `make` lists them; the npm scripts in package.json do the work.
.DEFAULT_GOAL := help
.PHONY: help install dev start test typecheck check passwd sandbox \
	docker-dev docker-passwd docker-logs docker-down deploy deploy-remote

export OPENUI_TELEMETRY_DISABLED := 1

# `make docker-dev` keeps its data apart from `make dev`'s data/.
DOCKER_DEV_DATA ?= $(CURDIR)/data/docker
DEV_COMPOSE = docker compose -f compose.yaml -f deploy/compose.dev.yaml
# Values compose.yaml requires; on a server they come from .env instead.
DEV_ENV = GENSE_DATA=$(DOCKER_DEV_DATA) GENSE_DOMAIN=localhost \
	GENSE_UID=$$(id -u) GENSE_GID=$$(id -g) DOCKER_GID=$$(stat -c %g /var/run/docker.sock)

# `make deploy-remote DEPLOY_HOST=user@vps`: a checkout of this repository on the server, with its .env.
DEPLOY_HOST ?=
DEPLOY_DIR ?= gense-bot

help: ## List the commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  make %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	npm ci

dev: ## Server (restarts on change) and Vite on http://localhost:5173
	npm run dev

start: ## Build the web app and run the server as in production, on http://127.0.0.1:8787
	npm run build && npm start

test: ## All tests (sandbox tests need `make sandbox` first)
	npm test

typecheck: ## Type-check everything, run server tests, verify the generated UI reference
	npm run check

check: ## Type-check protocol/server, then run server tests
	npm run check:server

passwd: ## Set the login password for `make dev` / `make start`
	npm run passwd

sandbox: ## Build the sandbox images (slim and full)
	npm run sandbox:build

docker-dev: ## The production container on http://127.0.0.1:8787, data in data/docker
	mkdir -p $(DOCKER_DEV_DATA)
	$(DEV_ENV) $(DEV_COMPOSE) up --build app

docker-passwd: ## Set the password inside the `make docker-dev` container
	$(DEV_ENV) $(DEV_COMPOSE) exec app npm run passwd

# logs and down do not use these values, but compose.yaml needs them set; a server's .env loses to them harmlessly.
docker-logs: ## Follow the app's logs (docker-dev or deploy)
	$(DEV_ENV) docker compose logs -f app

docker-down: ## Stop and remove the containers started by docker-dev or deploy
	$(DEV_ENV) docker compose down

deploy: ## On the server: build the sandbox images if missing, then (re)start app + Caddy
	@grep -q '^GENSE_DATA=' .env || { echo 'Set GENSE_DATA and the other deployment values in .env (see .env.example)'; exit 1; }
	mkdir -p "$$(sed -n 's/^GENSE_DATA="\{0,1\}\([^"]*\)"\{0,1\}$$/\1/p' .env)"
	docker image inspect gense-sandbox:slim gense-sandbox:full >/dev/null 2>&1 || docker compose --profile sandbox build
	docker compose up -d --build
	docker image prune -f

deploy-remote: ## From your computer: pull and deploy on DEPLOY_HOST (in DEPLOY_DIR)
	@test -n "$(DEPLOY_HOST)" || { echo 'Usage: make deploy-remote DEPLOY_HOST=user@host [DEPLOY_DIR=gense-bot]'; exit 1; }
	ssh $(DEPLOY_HOST) 'cd $(DEPLOY_DIR) && git pull --ff-only && make deploy'
