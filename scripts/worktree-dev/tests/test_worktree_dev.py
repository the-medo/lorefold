"""Regression checks for real isolation, retries, and destructive boundaries."""

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest


SCRIPT_DIR = Path(__file__).resolve().parents[1]
REPO = SCRIPT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))
spec = importlib.util.spec_from_file_location("worktree_dev", SCRIPT_DIR / "worktree_dev.py")
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


def execute(args, cwd=None, env=None, check=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=90)
    if check and result.returncode:
        raise AssertionError(f"Command failed ({result.returncode}): {args}\n{result.stdout}\n{result.stderr}")
    return result


class EnvironmentTests(unittest.TestCase):
    def test_literal_values_do_not_execute_or_expand_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            marker = Path(directory) / "should-not-exist"
            values = {"PATH_WITH_SPACES": "/tmp/a b/it's here", "SECRET": "literal # and $HOME",
                      "INJECTION": f"$(touch {marker})", "EMPTY": ""}
            path.write_text(dev.env_text(values))
            self.assertEqual(dev.parse_env(path), values)
            self.assertFalse(marker.exists())

    def test_invalid_lines_are_rejected_without_echoing_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text('SECRET="unclosed-sensitive-value\n')
            with self.assertRaises(dev.DevError) as error:
                dev.parse_env(path)
            self.assertNotIn("sensitive-value", str(error.exception))

    def test_identity_changes_by_worktree_and_clone_but_not_branch(self):
        first = dev.identity(Path("/repo/a"), Path("/repo/.git"))
        second = dev.identity(Path("/repo/b"), Path("/repo/.git"))
        clone = dev.identity(Path("/repo/a"), Path("/another/.git"))
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["id"], clone["id"])
        self.assertEqual(first["repo_id"], second["repo_id"])


@unittest.skipUnless(os.environ.get("LOREFOLD_DOCKER_TESTS") == "1", "opt-in Docker integration test")
class WorktreeIntegrationTests(unittest.TestCase):
    def setUp(self):
        execute(["docker", "info", "--format", "{{.ServerVersion}}"])
        execute(["docker", "image", "inspect", dev.IMAGE])
        self.temporary = tempfile.TemporaryDirectory(prefix="lorefold-worktree-test-")
        self.base = Path(self.temporary.name)
        self.worktrees = []
        self.foreign = []
        self.env = {**os.environ, "LOREFOLD_DEV_REGISTRY": str(self.base / "registry"),
                    "XDG_CONFIG_HOME": str(self.base / "config")}
        self.token = dev.digest(str(self.base))
        self.common = Path(execute(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=REPO).stdout.strip())
        self.addCleanup(self.cleanup)
        for name in ("first", "second with spaces"):
            path = self.base / name
            execute(["git", "worktree", "add", "--detach", str(path), "HEAD"], cwd=REPO)
            self.worktrees.append(path)
            # Test the working implementation, including changes not committed yet.
            shutil.copytree(SCRIPT_DIR, path / "scripts/worktree-dev", dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copyfile(REPO / ".env.example", path / ".env.example")
            shutil.copyfile(REPO / ".gitignore", path / ".gitignore")

    def cli(self, path, *args, check=True, extra_env=None):
        return execute([str(path / "scripts/worktree-dev/lorefold-worktree-dev"), *args],
                       cwd=path, env={**self.env, **(extra_env or {})}, check=check)

    def status(self, path):
        return json.loads(self.cli(path, "status", "--json").stdout)

    def sql(self, path, query):
        return self.cli(path, "psql", "--", "-Atqc", query).stdout.strip()

    def inspect(self, kind, name):
        result = execute(["docker", kind, "inspect", name], check=False)
        return json.loads(result.stdout)[0] if result.returncode == 0 else None

    def remove_foreign(self, kind, name):
        item = self.inspect(kind, name)
        if item:
            labels = (item.get("Config", {}).get("Labels") if kind == "container" else item.get("Labels")) or {}
            self.assertEqual(labels.get("com.lorefold.test.run"), self.token)
            execute(["docker", kind, "rm", name])

    def cleanup(self):
        errors = []
        for kind, name in self.foreign:
            try:
                self.remove_foreign(kind, name)
            except Exception as exc:
                errors.append(str(exc))
        for path in self.worktrees:
            if path.exists():
                result = self.cli(path, "down", "--purge-data", check=False)
                if result.returncode and "not configured" not in result.stderr:
                    errors.append(result.stderr)
        # Removed worktree paths can still have registry-owned resources.
        result = execute([str(REPO / "scripts/worktree-dev/lorefold-worktree-dev"), "prune", "--yes"],
                         cwd=REPO, env=self.env, check=False)
        if result.returncode:
            errors.append(result.stderr)
        for path in self.worktrees:
            if path.exists():
                result = execute(["git", "worktree", "remove", "--force", str(path)], cwd=REPO, check=False)
                if result.returncode:
                    errors.append(result.stderr)
        if errors:
            # Preserve state for diagnosis; never broaden cleanup to global resources.
            self.temporary._finalizer.detach()
            self.fail(f"Test cleanup needs attention at {self.base}: {'; '.join(errors)}")
        self.temporary.cleanup()

    def test_concurrent_worktrees_preserve_isolation_and_cleanup_boundaries(self):
        first, second = self.worktrees
        initial_env = "# Developer settings\nDATABASE_URL=postgresql://never-use.invalid/production\nCUSTOM=preserved\n"
        (first / ".env").write_text(initial_env)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda path: self.cli(path, "setup"), self.worktrees))
        self.assertTrue(all(result.returncode == 0 for result in results))
        one, two = self.status(first), self.status(second)
        from_other_directory = execute([str(first / "scripts/worktree-dev/lorefold-worktree-dev"), "status", "--json"],
                                       cwd=second, env=self.env)
        self.assertEqual(json.loads(from_other_directory.stdout)["id"], one["id"])
        self.assertNotEqual(one["container"], two["container"])
        self.assertNotEqual(one["volume"], two["volume"])
        self.assertFalse(set(one["ports"].values()) & set(two["ports"].values()))
        self.assertEqual(one["app_implemented"], (first / "backend/index.ts").is_file())
        self.assertEqual(one["app_status"], "unavailable")
        (first / "backend").mkdir(exist_ok=True)
        (first / "backend/index.ts").touch(exist_ok=True)
        self.assertTrue(self.status(first)["app_implemented"])
        self.assertEqual((first / ".env").read_text(), initial_env)
        state_a = json.loads((first / ".lorefold/state.json").read_text())
        state_b = json.loads((second / ".lorefold/state.json").read_text())
        self.assertNotEqual(state_a["password"], state_b["password"])
        self.assertNotEqual(state_a["auth_secret"], state_b["auth_secret"])
        for path, state in ((first, state_a), (second, state_b)):
            container = self.inspect("container", state["container"])
            self.assertEqual(container["Config"]["Labels"]["com.lorefold.dev.path"], str(path))
            self.assertEqual(container["HostConfig"]["PortBindings"]["5432/tcp"],
                             [{"HostIp": "127.0.0.1", "HostPort": str(state["ports"]["database"])}])
            self.assertEqual((path / ".env.worktree").stat().st_mode & 0o777, 0o600)
            self.assertNotIn(state["password"], self.cli(path, "status", "--json").stdout)

        self.sql(first, "CREATE TABLE isolation_probe(value text); INSERT INTO isolation_probe VALUES ('first-only');")
        self.assertEqual(self.sql(second, "SELECT to_regclass('public.isolation_probe') IS NULL"), "t")
        self.cli(first, "setup")
        self.assertEqual(self.sql(first, "SELECT value FROM isolation_probe"), "first-only")
        self.assertEqual(json.loads((first / ".lorefold/state.json").read_text()), state_a)

        # Copied generated files cannot redirect a command to the other DB or a remote DB.
        shutil.copyfile(second / ".env.worktree", first / ".env.worktree")
        with (first / "frontend/.env.worktree").open("a") as stream:
            stream.write("DATABASE_URL=postgresql://never-use.invalid/production\n")
        check_env = (
            "import os, json, subprocess; from pathlib import Path; "
            "s=json.loads(Path('.lorefold/state.json').read_text()); "
            "assert os.environ['PGPORT']==str(s['ports']['database']); "
            "assert '@127.0.0.1:'+str(s['ports']['database'])+'/' in os.environ['DATABASE_URL']; "
            "assert os.environ['CUSTOM']=='preserved'; "
            "assert os.environ['AUTH_COOKIE_PREFIX']=='lorefold-'+s['id']; "
            "assert s['id'] in os.environ['R2_KEY_PREFIX']; "
            # This would deadlock if run retained the registry lock across exec.
            "subprocess.run(['scripts/worktree-dev/lorefold-worktree-dev','status'],check=True,timeout=15,stdout=subprocess.DEVNULL)"
        )
        self.cli(first, "run", "--", sys.executable, "-c", check_env,
                 extra_env={"DATABASE_URL": "postgresql://never-use.invalid/inherited", "PGPORT": "1"})
        self.cli(first, "setup")

        # A copied identity must not make cleanup target another worktree.
        original = (first / ".lorefold/state.json").read_text()
        shutil.copyfile(second / ".lorefold/state.json", first / ".lorefold/state.json")
        try:
            result = self.cli(first, "down", "--purge-data", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("identity mismatch", result.stderr)
            self.assertEqual(self.sql(second, "SELECT 1"), "1")
        finally:
            (first / ".lorefold/state.json").write_text(original)

        self.cli(first, "down")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", one["ports"]["database"]))
            listener.listen()
            result = self.cli(first, "up", check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("port is occupied", result.stderr)
        self.cli(first, "setup")
        self.assertEqual(self.sql(first, "SELECT value FROM isolation_probe"), "first-only")

        # Simulate a conflicting resource name. Neither setup nor purge may touch it.
        self.cli(first, "down")
        execute(["docker", "container", "rm", one["container"]])
        execute(["docker", "create", "--name", one["container"], "--label", f"com.lorefold.test.run={self.token}",
                 "--entrypoint", "/bin/true", dev.IMAGE])
        self.foreign.append(("container", one["container"]))
        for args in (("setup",), ("down", "--purge-data")):
            result = self.cli(first, *args, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ownership mismatch", result.stderr)
            self.assertIsNotNone(self.inspect("volume", one["volume"]))
        self.remove_foreign("container", one["container"])
        self.foreign.remove(("container", one["container"]))
        self.cli(first, "setup")
        self.assertEqual(self.sql(first, "SELECT value FROM isolation_probe"), "first-only")

        # Either state copy can restore the other without changing credentials/data.
        (first / ".lorefold/state.json").unlink()
        self.cli(first, "setup")
        registry_file = self.base / "registry" / f"{state_a['id']}.json"
        registry_file.unlink()
        self.cli(first, "setup")
        self.assertEqual(json.loads(registry_file.read_text()), state_a)

        self.cli(first, "down", "--purge-data")
        self.assertIsNone(self.inspect("container", one["container"]))
        self.assertIsNone(self.inspect("volume", one["volume"]))
        self.assertEqual((first / ".env").read_text(), initial_env)
        self.assertFalse(self.status(first)["configured"])
        self.assertEqual(self.sql(second, "SELECT 1"), "1")

        # Newly encountered, unlabelled-by-Lorefold volumes must not be adopted.
        execute(["docker", "volume", "create", "--label", f"com.lorefold.test.run={self.token}", one["volume"]])
        self.foreign.append(("volume", one["volume"]))
        result = self.cli(first, "setup", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("state is missing", result.stderr)
        self.remove_foreign("volume", one["volume"])
        self.foreign.remove(("volume", one["volume"]))

        self.cli(first, "prune", "--yes")
        self.assertEqual(self.sql(second, "SELECT 1"), "1")
        execute(["git", "worktree", "remove", "--force", str(second)], cwd=REPO)
        preview = self.cli(first, "prune")
        self.assertIn(two["volume"], preview.stdout)
        self.assertIsNotNone(self.inspect("container", two["container"]))
        self.cli(first, "prune", "--yes")
        self.assertIsNone(self.inspect("container", two["container"]))
        self.assertIsNone(self.inspect("volume", two["volume"]))


if __name__ == "__main__":
    unittest.main()
