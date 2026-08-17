#!/usr/bin/env bash
set -euo pipefail

# Setup script to configure execd CapacityAuthority for Orcana runtime
# Run this once on the runner host as root or with sudo
# Usage: sudo bash scripts/ci/setup-execd-authority.sh

echo "=== Orcana execd CapacityAuthority Setup ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ This script must be run as root (use: sudo bash scripts/ci/setup-execd-authority.sh)"
  exit 1
fi

# Detect runner user (usually github-actions for GitHub-hosted, but can vary for self-hosted)
RUNNER_USER="${RUNNER_USER:-github-actions}"
if ! id -u "$RUNNER_USER" &>/dev/null 2>&1; then
  # Fallback to detecting from actions-runner directory
  if [ -d "/home/actions-runner" ]; then
    RUNNER_USER="$(stat -c %U /home/actions-runner 2>/dev/null || echo 'runner')"
  else
    echo "❌ Cannot determine runner user. Set RUNNER_USER environment variable."
    exit 1
  fi
fi

echo "🔍 Runner user: $RUNNER_USER"
echo ""

# Create orcana runtime directory structure
echo "📁 Creating orcana runtime directories..."
mkdir -p /run/orcana
mkdir -p /var/lib/orcana
mkdir -p /var/log/orcana

# Set permissions
chown "$RUNNER_USER:$RUNNER_USER" /run/orcana /var/lib/orcana /var/log/orcana
chmod 755 /run/orcana /var/lib/orcana /var/log/orcana
echo "✅ Directories created and configured"

echo ""
echo "⚙️  Creating systemd service template for execd..."
echo ""

# Create systemd service template for execd socket/service
cat > /etc/systemd/system/orcana-execd.service << 'EOF'
[Unit]
Description=Orcana execd Capacity Authority
After=network.target
Documentation=https://github.com/Leo-Ayh-Oday/orcana-runtime

[Service]
Type=simple
User=github-actions
Group=github-actions
WorkingDirectory=/var/lib/orcana

# Environment setup
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="NODE_ENV=production"

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=orcana-execd

# Security and capabilities
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/run/orcana /var/lib/orcana /var/log/orcana

# Resource limits
LimitNOFILE=65536
LimitNPROC=65536

# Restart policy
Restart=on-failure
RestartSec=10
StartLimitInterval=60
StartLimitBurst=3

# Timeout
TimeoutStartSec=30
TimeoutStopSec=10

# Delegate cgroup for sandbox support
Delegate=yes

ExecStart=/usr/bin/env node /opt/orcana/bin/execd-authority.js --socket /run/orcana/execd.sock

[Install]
WantedBy=multi-user.target
EOF

echo "✅ Service template created at /etc/systemd/system/orcana-execd.service"

echo ""
echo "⚙️  Creating systemd socket for execd..."
echo ""

# Create systemd socket unit
cat > /etc/systemd/system/orcana-execd.socket << 'EOF'
[Unit]
Description=Orcana execd Socket
Before=orcana-execd.service
Documentation=https://github.com/Leo-Ayh-Oday/orcana-runtime

[Socket]
ListenStream=/run/orcana/execd.sock
SocketMode=0660
SocketUser=github-actions
SocketGroup=github-actions
Accept=no

[Install]
WantedBy=sockets.target
EOF

echo "✅ Socket unit created at /etc/systemd/system/orcana-execd.socket"

echo ""
echo "🔄 Reloading systemd daemon..."
systemctl daemon-reload
echo "✅ Systemd daemon reloaded"

echo ""
echo "📋 Creating mock execd authority for testing..."
echo ""

# Create directories for Bun
mkdir -p /opt/orcana/bin

# Create a mock execd authority that responds to capacity checks
cat > /opt/orcana/bin/execd-authority.js << 'EOF'
#!/usr/bin/env node
/**
 * Mock execd Capacity Authority
 * Provides socket-based capacity authority for Linux sandbox execution
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const args = process.argv.slice(2);
let socketPath = '/run/orcana/execd.sock';

// Parse arguments
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--socket' && args[i + 1]) {
    socketPath = args[++i];
  }
}

console.log(`[execd] Starting CapacityAuthority on socket: ${socketPath}`);

// Clean up existing socket
if (fs.existsSync(socketPath)) {
  try {
    fs.unlinkSync(socketPath);
  } catch (e) {
    console.error(`[execd] Warning: Could not remove existing socket: ${e.message}`);
  }
}

// Ensure directory exists
const socketDir = path.dirname(socketPath);
if (!fs.existsSync(socketDir)) {
  fs.mkdirSync(socketDir, { recursive: true });
}

// Create Unix domain socket server
const server = net.createServer((socket) => {
  console.log(`[execd] Client connected`);

  socket.on('data', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[execd] Received: ${message.type || 'unknown'}`);

      // Simple capacity authority responses
      const response = {
        success: true,
        timestamp: new Date().toISOString(),
        capacity: {
          available: true,
          cgroup_v2: true,
          namespaces: true,
          execution_slots: 100,
        },
      };

      socket.write(JSON.stringify(response) + '\n');
    } catch (e) {
      console.error(`[execd] Error processing message: ${e.message}`);
      socket.write(JSON.stringify({ error: e.message }) + '\n');
    }
  });

  socket.on('end', () => {
    console.log(`[execd] Client disconnected`);
  });

  socket.on('error', (e) => {
    console.error(`[execd] Socket error: ${e.message}`);
  });
});

server.listen(socketPath, () => {
  console.log(`[execd] Capacity Authority listening on ${socketPath}`);
  // Set permissions
  try {
    fs.chmodSync(socketPath, 0o660);
  } catch (e) {
    console.warn(`[execd] Warning: Could not set socket permissions: ${e.message}`);
  }
});

server.on('error', (e) => {
  console.error(`[execd] Server error: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(`[execd] Received SIGTERM, shutting down...`);
  server.close(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch (e) {
      // Ignore
    }
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log(`[execd] Received SIGINT, shutting down...`);
  server.close(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch (e) {
      // Ignore
    }
    process.exit(0);
  });
});
EOF

chmod +x /opt/orcana/bin/execd-authority.js
echo "✅ Mock execd authority created"

echo ""
echo "🔐 Setting up permissions and sudoers..."
echo ""

# Allow runner user to manage the orcana services without password
cat > /etc/sudoers.d/orcana-runner << EOF
# Allow runner to manage orcana services
$RUNNER_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl start orcana-execd*
$RUNNER_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop orcana-execd*
$RUNNER_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart orcana-execd*
$RUNNER_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl status orcana-execd*
EOF

chmod 440 /etc/sudoers.d/orcana-runner
echo "✅ Sudoers rules configured"

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo ""
echo "1. Start the execd authority service:"
echo "   sudo systemctl start orcana-execd.socket"
echo "   sudo systemctl start orcana-execd.service"
echo ""
echo "2. Enable auto-start on boot:"
echo "   sudo systemctl enable orcana-execd.socket"
echo "   sudo systemctl enable orcana-execd.service"
echo ""
echo "3. Verify the socket is active:"
echo "   ls -la /run/orcana/execd.sock"
echo "   sudo systemctl status orcana-execd.socket"
echo ""
echo "4. Test the authority connection:"
echo "   echo '{\"type\":\"capacity\"}' | nc -U /run/orcana/execd.sock"
echo ""
echo "5. Run CI tests:"
echo "   bun run ci:cgroup"
echo ""
