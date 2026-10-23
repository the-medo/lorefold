"""Private browser access and session-independent Linux development services."""

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
from urllib.parse import urlsplit
from urllib.request import urlopen


class RuntimeError(Exception):
    pass


def call(args, *, check=True):
    result = subprocess.run(args, capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result


def profile_path():
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "lorefold/worktree-dev/access.json"


def origin(access, port):
    template = access.get("origin_template", "http://localhost:{frontend_port}")
    if template.count("{frontend_port}") != 1:
        raise RuntimeError("The origin template must contain {frontend_port} exactly once.")
    value = template.replace("{frontend_port}", str(port))
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme in ("http", "https") and parsed.hostname and parsed.port == port
                 and not parsed.username and not parsed.password and not parsed.query
                 and not parsed.fragment and parsed.path in ("", "/")
                 and parsed.netloc.endswith(f":{port}")
                 and not any(char.isspace() or char in "{}\\" for char in value))
    except ValueError:
        valid = False
    if not valid:
        raise RuntimeError("Use an exact HTTP(S) origin with :{frontend_port}, without credentials or a path.")
    tailscale = access.get("tailscale_serve", False)
    if type(tailscale) is not bool:
        raise RuntimeError("tailscale_serve must be a boolean.")
    if tailscale:
        if parsed.scheme != "https" or not parsed.hostname.endswith(".ts.net"):
            raise RuntimeError("Tailscale Serve requires an HTTPS .ts.net origin.")
    elif parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise RuntimeError("Remote access requires private Tailscale Serve; otherwise use HTTP loopback.")
    return value.rstrip("/")


def load_access():
    path = profile_path()
    try:
        access = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(access, dict):
            raise ValueError()
        origin(access, 15173)
        return access
    except (ValueError, OSError) as exc:
        raise RuntimeError(f"Invalid access profile: {path}") from exc


def unit(state):
    return f"lorefold-dev-{state['id']}.service"


def service(state):
    # setup/status remain usable on Linux without a systemd user manager.
    if not shutil.which("systemctl"):
        return "unavailable"
    result = call(["systemctl", "--user", "show", unit(state),
                   "--property=LoadState,ActiveState,WorkingDirectory,Description"], check=False)
    properties = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if not properties:
        return "unavailable"
    if properties.get("LoadState") == "not-found":
        return "missing"
    if (properties.get("WorkingDirectory") != state["root"]
            or properties.get("Description") != f"Lorefold worktree {state['id']}"):
        raise RuntimeError("Application service ownership mismatch; refusing to alter it.")
    return properties.get("ActiveState", "unknown")


def serve_configuration():
    return json.loads(call(["tailscale", "serve", "status", "--json"]).stdout)


def serve_state(state, config=None):
    if not state.get("access", {}).get("tailscale_serve"):
        return "disabled"
    config = serve_configuration() if config is None else config
    port = str(state["ports"]["frontend"])
    host = urlsplit(origin(state["access"], int(port))).hostname
    web = config.get("Web", {})
    entries = {key: value for key, value in web.items() if key.endswith(f":{port}")}
    tcp = config.get("TCP", {}).get(port)
    funnel = any(value for key, value in config.get("AllowFunnel", {}).items() if key.endswith(f":{port}"))
    if not tcp and not entries and not funnel:
        return "missing"
    wanted = {f"{host}:{port}": {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{port}"}}}}
    if tcp == {"HTTPS": True} and entries == wanted and not funnel:
        return "ready"
    raise RuntimeError(f"Tailscale port {port} has a different configuration; refusing to alter it.")


def check_access(state, *, check_route=True):
    if not state.get("access", {}).get("tailscale_serve"):
        return
    host = urlsplit(origin(state["access"], state["ports"]["frontend"])).hostname
    current = json.loads(call(["tailscale", "status", "--json"]).stdout)
    if current.get("Self", {}).get("DNSName", "").rstrip(".").lower() != host:
        raise RuntimeError("The access profile hostname must match this machine's Tailscale DNS name.")
    if check_route:
        serve_state(state)


def start(state):
    current = service(state)
    if current in ("active", "activating"):
        return
    if current == "unavailable":
        raise RuntimeError("Background up requires a systemd user manager. Foreground fallback: run -- npm run dev.")
    check_access(state)
    node = shutil.which("node")
    if not node or not (Path(state["root"]) / "node_modules/.bin/vite").exists():
        raise RuntimeError("Install Node 24+, put it on PATH, and run npm ci before up.")
    for name in ("backend", "frontend"):
        with socket.socket() as reservation:
            # Match Node's listen behavior after a previous server's connections
            # enter TIME_WAIT; a live listener still prevents this bind.
            reservation.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                reservation.bind(("127.0.0.1", state["ports"][name]))
                reservation.listen()
            except OSError as exc:
                raise RuntimeError(f"Reserved {name} port is occupied. Stop its owner before up.") from exc
    if current != "missing":
        call(["systemctl", "--user", "stop", unit(state)])
        call(["systemctl", "--user", "reset-failed", unit(state)], check=False)
    launcher = str(Path(state["root"]) / "scripts/worktree-dev/lorefold-worktree-dev")
    # The unit contains paths only. The launcher reads private environment files
    # after the caller releases its registry lock; credentials never enter argv.
    arguments = ["systemd-run", "--user", "--quiet", "--collect", f"--unit={unit(state)}",
                 f"--description=Lorefold worktree {state['id']}",
                 f"--property=WorkingDirectory={state['root']}",
                 "--property=KillMode=control-group", "--property=TimeoutStopSec=10",
                 "--property=Restart=on-failure", "--property=RestartSec=2",
                 f"--setenv=PATH={os.environ['PATH']}"]
    for key in ("LOREFOLD_DEV_REGISTRY", "XDG_STATE_HOME"):
        if key in os.environ:
            arguments.append(f"--setenv={key}={os.environ[key]}")
    call([*arguments, launcher, "run", "--", node, "scripts/dev.mjs"])


def healthy(url):
    try:
        with urlopen(url, timeout=2) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def wait_ready(state):
    port = state["ports"]["frontend"]
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if healthy(f"http://127.0.0.1:{port}/") and healthy(f"http://127.0.0.1:{port}/api/health"):
            break
        time.sleep(0.5)
    else:
        raise RuntimeError(f"Application did not become healthy. Inspect journalctl --user -u {unit(state)}.")
    if state.get("access", {}).get("tailscale_serve"):
        check_access(state)
        if serve_state(state) == "missing":
            call(["tailscale", "serve", f"--https={port}", "--bg", f"http://127.0.0.1:{port}"])
        if not healthy(origin(state["access"], port) + "/api/health"):
            raise RuntimeError("Local application is healthy but its private browser URL is unreachable.")


def stop(state):
    current = service(state)
    mapping = serve_state(state)
    if current not in ("missing", "unavailable"):
        call(["systemctl", "--user", "stop", unit(state)])
    if mapping == "ready":
        call(["tailscale", "serve", f"--https={state['ports']['frontend']}", "off"])
