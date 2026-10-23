"""Access defaults and refusal to modify foreign routes/services."""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import runtime


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.state = {"id": "test-worktree", "root": "/test/worktree", "ports": {"frontend": 15237},
                      "access": {"origin_template": "https://dev.example.ts.net:{frontend_port}", "tailscale_serve": True}}
        self.mapping = {
            "TCP": {"15237": {"HTTPS": True}, "5173": {"HTTPS": True}},
            "Web": {
                "dev.example.ts.net:15237": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:15237"}}},
                "dev.example.ts.net:5173": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:5173"}}},
            },
        }

    def test_machine_profile_is_inherited_with_each_worktrees_own_port(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"XDG_CONFIG_HOME": directory}):
            self.assertEqual(runtime.origin(runtime.load_access(), 15173), "http://localhost:15173")
            profile = runtime.profile_path()
            profile.parent.mkdir(parents=True)
            profile.write_text(json.dumps(self.state["access"]))
            self.assertEqual(runtime.origin(runtime.load_access(), 15237), "https://dev.example.ts.net:15237")
            self.assertEqual(runtime.origin(runtime.load_access(), 15238), "https://dev.example.ts.net:15238")

    def test_rejects_nonprivate_origins_and_ambiguous_templates(self):
        for template, tailscale in [
            ("https://dev.example.ts.net:15237", True),
            ("https://dev.example.ts.net:{frontend_port}/path", True),
            ("https://user:secret@dev.example.ts.net:{frontend_port}", True),
            ("http://dev.example.ts.net:{frontend_port}", True),
            ("https://public.example:{frontend_port}", False),
            ("http://localhost:{frontend_port}/?origin={frontend_port}", False),
        ]:
            with self.subTest(template=template), self.assertRaises(runtime.RuntimeError):
                runtime.origin({"origin_template": template, "tailscale_serve": tailscale}, 15237)

    def test_matching_route_can_coexist_with_other_apps(self):
        self.assertEqual(runtime.serve_state(self.state, self.mapping), "ready")
        self.assertEqual(runtime.serve_state(self.state, {}), "missing")

    def test_conflicting_route_or_funnel_is_never_adopted(self):
        variants = []
        wrong_proxy = copy.deepcopy(self.mapping)
        wrong_proxy["Web"]["dev.example.ts.net:15237"]["Handlers"]["/"]["Proxy"] = "http://127.0.0.1:3000"
        variants.append(wrong_proxy)
        additional_handler = copy.deepcopy(self.mapping)
        additional_handler["Web"]["dev.example.ts.net:15237"]["Handlers"]["/another"] = {"Text": "foreign"}
        variants.append(additional_handler)
        variants.append({**self.mapping, "AllowFunnel": {"dev.example.ts.net:15237": True}})
        for config in variants:
            with self.subTest(config=config), self.assertRaises(runtime.RuntimeError):
                runtime.serve_state(self.state, config)

    def test_stop_only_removes_exact_worktree_route_and_unit(self):
        with patch.object(runtime, "service", return_value="active"), \
                patch.object(runtime, "serve_configuration", return_value=self.mapping), \
                patch.object(runtime, "call") as call:
            runtime.stop(self.state)
            self.assertEqual([args.args[0] for args in call.call_args_list], [
                ["systemctl", "--user", "stop", "lorefold-dev-test-worktree.service"],
                ["tailscale", "serve", "--https=15237", "off"],
            ])

    def test_route_conflict_prevents_stopping_even_the_app(self):
        with patch.object(runtime, "service", return_value="active"), \
                patch.object(runtime, "serve_configuration", return_value={"TCP": {"15237": {"TCPForward": "localhost:3000"}}}), \
                patch.object(runtime, "call") as call:
            with self.assertRaises(runtime.RuntimeError):
                runtime.stop(self.state)
            call.assert_not_called()

    def test_service_cannot_be_stopped_if_its_directory_does_not_match(self):
        result = subprocess.CompletedProcess([], 0,
            "LoadState=loaded\nActiveState=active\nWorkingDirectory=/foreign\nDescription=Lorefold worktree test-worktree\n", "")
        with patch.object(runtime.shutil, "which", return_value="systemctl"), patch.object(runtime, "call", return_value=result):
            with self.assertRaisesRegex(runtime.RuntimeError, "ownership mismatch"):
                runtime.service(self.state)


if __name__ == "__main__":
    unittest.main()
