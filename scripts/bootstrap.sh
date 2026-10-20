#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

echo -e "\033[0;36m============================================================\033[0m"
echo -e "\033[0;36m                NodePilot Game Server Manager               \033[0m"
echo -e "\033[0;36m============================================================\033[0m"
echo ""

get_node_major() {
  if command -v node >/dev/null 2>&1; then
    node -v | sed 's/^v//' | cut -d. -f1
  else
    echo "0"
  fi
}

# Check local managed node in .nodepilot/tools/node
TOOLS_NODE_DIR="${ROOT_DIR}/.nodepilot/tools/node"
if [ -d "${TOOLS_NODE_DIR}" ]; then
  for dir in "${TOOLS_NODE_DIR}"/node-v*; do
    if [ -x "${dir}/bin/node" ]; then
      export PATH="${dir}/bin:${PATH}"
      break
    fi
  done
fi

NODE_MAJOR=$(get_node_major)

if [ "${NODE_MAJOR}" -lt 20 ]; then
  if [ "${NODE_MAJOR}" -eq 0 ]; then
    echo -e "\033[0;33m[NodePilot] Node.js is not installed on this system.\033[0m"
  else
    echo -e "\033[0;33m[NodePilot] Node.js major version ${NODE_MAJOR} detected, but NodePilot requires Node.js 20 or newer.\033[0m"
  fi
  echo -e "\033[0;32m[NodePilot] Installing Node.js LTS automatically...\033[0m"

  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "${ARCH}" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) echo -e "\033[0;31m[NodePilot] Unsupported architecture ${ARCH}. Please install Node.js manually.\033[0m"; exit 1 ;;
  esac

  case "${OS}" in
    linux) NODE_OS="linux" ;;
    darwin) NODE_OS="darwin" ;;
    *) echo -e "\033[0;31m[NodePilot] Unsupported OS ${OS}. Please install Node.js manually.\033[0m"; exit 1 ;;
  esac

  mkdir -p "${TOOLS_NODE_DIR}"
  SHAS_URL="https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
  TAR_NAME=$(curl -sL "${SHAS_URL}" | grep -o "node-v22\.[0-9]\+\.[0-9]\+-${NODE_OS}-${NODE_ARCH}\.tar\.\(xz\|gz\)" | head -n1)

  if [ -z "${TAR_NAME}" ]; then
    echo -e "\033[0;31m[NodePilot] Failed to find latest Node.js LTS package. Please install Node.js manually.\033[0m"
    exit 1
  fi

  DOWNLOAD_URL="https://nodejs.org/dist/latest-v22.x/${TAR_NAME}"
  echo -e "\033[0;36m[NodePilot] Downloading ${TAR_NAME}...\033[0m"
  curl -sL "${DOWNLOAD_URL}" -o "${TOOLS_NODE_DIR}/${TAR_NAME}"

  echo -e "\033[0;36m[NodePilot] Extracting Node.js into .nodepilot/tools/node...\033[0m"
  tar -xf "${TOOLS_NODE_DIR}/${TAR_NAME}" -C "${TOOLS_NODE_DIR}"
  rm -f "${TOOLS_NODE_DIR}/${TAR_NAME}"

  EXTRACTED_DIR="${TOOLS_NODE_DIR}/${TAR_NAME%.tar.*}"
  export PATH="${EXTRACTED_DIR}/bin:${PATH}"

  if command -v node >/dev/null 2>&1; then
    echo -e "\033[0;32m[NodePilot] Node.js $(node -v) successfully set up!\033[0m"
  else
    echo -e "\033[0;31m[NodePilot] Node.js installation could not be verified.\033[0m"
    exit 1
  fi
else
  echo -e "\033[0;32m[NodePilot] Found Node.js $(node -v) on PATH.\033[0m"
fi

if [ ! -d "${ROOT_DIR}/node_modules" ]; then
  echo ""
  echo -e "\033[0;36m[NodePilot] Installing application dependencies (npm install)...\033[0m"
  npm install
fi

if [ ! -d "${ROOT_DIR}/server/dist" ] || [ ! -d "${ROOT_DIR}/client/dist" ]; then
  echo ""
  echo -e "\033[0;36m[NodePilot] Building NodePilot client and server (npm run build)...\033[0m"
  npm run build
fi

echo ""
echo -e "\033[0;32m[NodePilot] Starting NodePilot dashboard...\033[0m"
echo -e "\033[0;90m[NodePilot] Press Ctrl+C in this terminal to stop the server.\033[0m"
echo ""

npm start
