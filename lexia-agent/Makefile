.PHONY: build up down restart logs clean help

# Docker image and container names
IMAGE_NAME = brikz-agent
CONTAINER_NAME = brikz-agent-api
TAG = latest
PORT_MAPPING = 8000:8000

# Get the current directory
CURRENT_DIR = $(shell pwd)

# Default target
.DEFAULT_GOAL := help

help: ## Show this help message
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Build the Docker image
	@echo "🔨 Building Docker image: $(IMAGE_NAME):$(TAG)..."
	docker build -t $(IMAGE_NAME):$(TAG) .
	@echo "✅ Build complete!"

up: ## Start the container with volume mounts (live code updates)
	@echo "🚀 Starting container: $(CONTAINER_NAME)..."
	@docker run -d \
		--name $(CONTAINER_NAME) \
		-p $(PORT_MAPPING) \
		-v $(CURRENT_DIR):/app:rw \
		-v $(CURRENT_DIR)/data:/app/data:rw \
		--env-file .env \
		$(IMAGE_NAME):$(TAG)
	@echo "✅ Container started!"
	@echo "📍 API available at: http://localhost:8000"
	@echo "📍 Docs available at: http://localhost:8000/docs"
	@echo "📋 View logs: make logs"

down: ## Stop and remove the container
	@echo "🛑 Stopping container: $(CONTAINER_NAME)..."
	@docker stop $(CONTAINER_NAME) 2>/dev/null || true
	@echo "🗑️  Removing container: $(CONTAINER_NAME)..."
	@docker rm $(CONTAINER_NAME) 2>/dev/null || true
	@echo "✅ Container stopped and removed!"

restart: down up ## Restart the container (down + up)

logs: ## Show container logs (follow mode)
	@echo "📋 Showing logs for: $(CONTAINER_NAME)"
	@echo "   Press Ctrl+C to exit"
	@docker logs -f $(CONTAINER_NAME)

logs-tail: ## Show last 100 lines of container logs
	@docker logs --tail 100 $(CONTAINER_NAME)

shell: ## Open a shell inside the running container
	@echo "🐚 Opening shell in container: $(CONTAINER_NAME)"
	@docker exec -it $(CONTAINER_NAME) /bin/bash

ps: ## Show container status
	@echo "📊 Container status:"
	@docker ps -a | grep -E "CONTAINER ID|$(CONTAINER_NAME)" || echo "Container not found"

clean: down ## Stop container and remove image
	@echo "🧹 Removing Docker image: $(IMAGE_NAME):$(TAG)..."
	@docker rmi $(IMAGE_NAME):$(TAG) 2>/dev/null || true
	@echo "✅ Cleanup complete!"

rebuild: clean build ## Clean rebuild (remove image + build)

redeploy: down build up ## Full redeploy (down + build + up)

inspect: ## Inspect the running container
	@docker inspect $(CONTAINER_NAME) 2>/dev/null || echo "❌ Container not running"

stats: ## Show container resource usage
	@docker stats $(CONTAINER_NAME) --no-stream 2>/dev/null || echo "❌ Container not running"

# Development targets
dev: ## Run locally with uvicorn (no Docker)
	@echo "🚀 Starting dev server on port 8000..."
	python main.py

dev-setup: build ## Initial development setup
	@echo "🔧 Setting up development environment..."
	@mkdir -p data/subagents data/outputs logs
	@echo "✅ Development environment ready!"
	@echo "   Run 'make up' to start the container"

test: ## Run tests
	@echo "🧪 Running tests..."
	python -m pytest tests/ -v
	@echo "✅ Tests complete!"

# ── Release build targets ────────────────────────────────────────────────────

VERSION ?= latest
RELEASE_DIST = dist

PLATFORM ?= linux/amd64

release-build: ## Build release Docker image (Cython-compiled, no source, linux/amd64)
	@echo "🔒 Building release image: $(IMAGE_NAME):$(VERSION) for $(PLATFORM)..."
	docker buildx build -f Dockerfile.release \
		--platform $(PLATFORM) \
		--build-arg LEXIA_BUILD_KEY="$(LEXIA_BUILD_KEY)" \
		--load \
		-t $(IMAGE_NAME):$(VERSION) .
	@echo "✅ Release build complete!"

release-frontend: ## Build frontend release Docker image (linux/amd64)
	@echo "🔒 Building frontend release image for $(PLATFORM)..."
	cd ../brikz-frontend && docker buildx build -f Dockerfile.release \
		--platform $(PLATFORM) \
		--build-arg VITE_API_URL="$(VITE_API_URL)" \
		--load \
		-t brikz-frontend:$(VERSION) .
	@echo "✅ Frontend release build complete!"

release-frontend-dist: ## Build frontend static dist (no Docker) + tar.gz artifact
	@echo "🔨 Building frontend static dist..."
	@echo "   (VITE_API_URL comes from brikz-frontend/.env.production unless overridden)"
	@if [ -n "$(VITE_API_URL)" ]; then echo "   Override: VITE_API_URL=$(VITE_API_URL)"; fi
	cd ../brikz-frontend && rm -rf dist && npm ci --silent && \
		$(if $(VITE_API_URL),VITE_API_URL="$(VITE_API_URL)",) npm run build
	@mkdir -p $(RELEASE_DIST)
	@echo "📦 Packaging brikz-frontend-dist-$(VERSION).tar.gz..."
	tar -C ../brikz-frontend -czf $(RELEASE_DIST)/brikz-frontend-dist-$(VERSION).tar.gz dist
	@ls -lh $(RELEASE_DIST)/brikz-frontend-dist-$(VERSION).tar.gz
	@echo "✅ Frontend dist ready: $(RELEASE_DIST)/brikz-frontend-dist-$(VERSION).tar.gz"
	@echo "   Baked API URL: $$(grep -ho 'http[s]*://[^"\'' ]*' ../brikz-frontend/dist/assets/*.js | sort -u | head -5)"

release-export: ## Export release images as .tar.gz for offline delivery
	@mkdir -p $(RELEASE_DIST)
	@echo "📦 Exporting $(IMAGE_NAME):$(VERSION)..."
	docker save $(IMAGE_NAME):$(VERSION) | gzip > $(RELEASE_DIST)/brikz-agent-$(VERSION).tar.gz
	@echo "📦 Exporting brikz-frontend:$(VERSION)..."
	docker save brikz-frontend:$(VERSION) | gzip > $(RELEASE_DIST)/brikz-frontend-$(VERSION).tar.gz
	@echo "✅ Release artifacts in $(RELEASE_DIST)/"
	@ls -lh $(RELEASE_DIST)/*.tar.gz

release-all: release-build release-frontend release-export ## Full release pipeline
	@echo "✅ All release artifacts ready in $(RELEASE_DIST)/"
	@echo ""
	@echo "Client deployment:"
	@echo "  1. Copy $(RELEASE_DIST)/*.tar.gz to client VM"
	@echo "  2. docker load < brikz-agent-$(VERSION).tar.gz"
	@echo "  3. docker load < brikz-frontend-$(VERSION).tar.gz"
	@echo "  4. Copy deploy/ directory, fill .env, run: docker compose -f deploy/docker-compose.yml up -d"

release-verify: ## Verify release image contains no .py source
	@echo "🔍 Checking for source code leaks..."
	@echo "--- .py files in image ---"
	@docker run --rm $(IMAGE_NAME):$(VERSION) find /app -name "*.py" 2>/dev/null || true
	@echo "--- .md files in image ---"
	@docker run --rm $(IMAGE_NAME):$(VERSION) find /app -name "*.md" 2>/dev/null || true
	@echo "--- .so files count ---"
	@docker run --rm $(IMAGE_NAME):$(VERSION) sh -c 'find /app -name "*.so" | wc -l'
	@echo "--- .md.enc files count ---"
	@docker run --rm $(IMAGE_NAME):$(VERSION) sh -c 'find /app -name "*.md.enc" | wc -l'
