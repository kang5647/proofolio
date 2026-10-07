# ProofDesk services image: source, verifier (with CRE CLI + Bun for `cre workflow simulate`), buyer.
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git bash unzip gnupg && rm -rf /var/lib/apt/lists/*
# Bun (CRE TypeScript workflows compile with bun)
RUN curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun
# CRE CLI (pinned by the install script; see docs/evidence for the version used)
RUN curl -sSL https://app.chain.link/cre/install.sh | bash && ln -s /root/.cre/bin/cre /usr/local/bin/cre
# Foundry (cast/anvil for the local-chain profile only)
RUN curl -L https://foundry.paradigm.xyz | bash && /root/.foundry/bin/foundryup >/dev/null 2>&1 || true
ENV PATH="/root/.foundry/bin:/root/.cre/bin:/root/.bun/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json ./
# The service entrypoints use tsx directly, so the runtime image needs the
# pinned dev toolchain as well as production dependencies.
RUN npm ci
COPY . .
RUN cd workflows/trading-resume && bun install --frozen-lockfile || bun install
ENV HOST=0.0.0.0
CMD ["npx", "tsx", "services/verifier/src/server.ts"]
