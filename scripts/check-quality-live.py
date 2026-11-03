"""Exercise the adaptive skill on synthetic code using ordinary Pi tools."""

import argparse
import json
import os
import queue
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/code-quality"
BRIDGE = ROOT / ".pi/npm/node_modules/pi-claude-bridge/src/index.ts"


def run_pi(command, root, prompt, response_limit, output):
    records = queue.Queue()
    with tempfile.TemporaryFile() as errors, output.open("w") as transcript:
        process = subprocess.Popen(command, cwd=root, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=errors, start_new_session=True)

        def read():
            for line in iter(process.stdout.readline, b""):
                records.put(line)
            records.put(None)

        threading.Thread(target=read, daemon=True).start()
        process.stdin.write(prompt.encode())
        process.stdin.close()
        events, responses = [], 0
        deadline = time.monotonic() + 600
        try:
            while True:
                line = records.get(timeout=max(0.1, deadline - time.monotonic()))
                if line is None:
                    break
                event = json.loads(line)
                if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant":
                    responses += 1
                    if responses > response_limit:
                        raise AssertionError("Live test exceeded its independent response limit")
                    event["message"]["content"] = [b for b in event["message"].get("content", []) if b["type"] == "text"]
                if event.get("type") in ("message_end", "tool_execution_start", "tool_execution_end", "agent_settled"):
                    events.append(event)
                    transcript.write(json.dumps(event) + "\n")
                    transcript.flush()
            process.wait(timeout=10)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            process.stdout.close()
        errors.seek(0)
        return subprocess.CompletedProcess(command, process.returncode,
            "\n".join(json.dumps(e) for e in events), errors.read().decode(errors="replace"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="openai/gpt-6.1-sol")
    parser.add_argument("--review", action="store_true")
    parser.add_argument("--output", type=Path, required=True,
                        help="Save visible tool calls and responses for inspection")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="quality-live-") as directory:
        folder = Path(directory)
        root = folder / "repo"
        root.mkdir()
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        shared = folder / "shared"
        shared.mkdir()
        (shared / "pricing.py").write_text(
            "def price(units):\n    return units * 5\n")
        (root / "pricing.py").symlink_to(shared / "pricing.py")
        (root / "cart.py").write_text(
            "from pricing import price\n"
            "def total(lines):\n    return price(sum(lines))\n")
        (root / "check.py").write_text(
            "from cart import total\nfrom pricing import price\n"
            "assert total([2, 3]) == 25\nassert price(0) == 0\n")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com",
                        "commit", "-qm", "Synthetic fixture"], cwd=root, check=True)
        prompt = (
            "Use the code-quality skill. Fix negative quantities: price must reject a negative "
            "integer with ValueError, and a cart must reject any negative line even when other "
            "lines make the total positive. Preserve zero and positive integer behaviour. "
            "Add regression evidence. pricing.py is a symlink to shared/pricing.py outside the "
            "repository: that specific target is explicitly in scope for reading, editing and review. "
            "Preserve the link. Everything here is synthetic. Use python3 -B for Python. "
        )
        if args.review:
            prompt += (
                "Obtain independent other-provider review of the result; investigate its findings "
                "before declaring completion. The bridge entry point is " + str(BRIDGE) + ". "
            )
        command = ["pi", "--mode", "json", "--print", "--no-session", "--no-approve",
                   "--no-extensions", "--no-skills", "--skill", str(SKILL),
                   "--no-context-files", "--no-mcp", "--no-prompt-templates",
                   "--tools", "read,edit,write,bash,grep,find,ls", "--model", args.model]
        if args.model.startswith("claude-bridge/"):
            command.extend(["-e", str(BRIDGE)])
        response = run_pi(command, root, prompt, 50, args.output)
        if response.returncode:
            raise RuntimeError(response.stderr[-4000:])
        events = [json.loads(line) for line in response.stdout.splitlines()]
        assert any(e.get("type") == "agent_settled" and not e.get("aborted") for e in events)
        assert (root / "pricing.py").is_symlink(), "Selected link was replaced"
        assert os.readlink(root / "pricing.py") == str(shared / "pricing.py"), "Selected link was retargeted"
        probe = subprocess.run(["python3", "-B", "-c",
            "from cart import total\nfrom pricing import price\n"
            "assert total([0, 7, 4]) == 55\nassert total([]) == 0\n"
            "assert price(9) == 45\nassert price(0) == 0\n"
            "for fn, value in [(price, -3), (total, [-2, 10]), (total, [10, -2]), (total, [-1])]:\n"
            "    try: fn(value)\n"
            "    except ValueError: pass\n"
            "    else: raise AssertionError((fn.__name__, value))"], cwd=root, capture_output=True)
        assert probe.returncode == 0, probe.stderr.decode()
        subprocess.run(["git", "add", "-N", "."], cwd=root, check=True)
        diff = subprocess.check_output(["git", "diff"], cwd=root, text=True)
        args.output.with_suffix(".diff").write_text(diff + "\nExternal selected pricing.py:\n" +
                                                   (shared / "pricing.py").read_text())
        print(json.dumps({"held_out_probes": "passed", "link_preserved": True,
                          "model": args.model, "output": str(args.output),
                          "review_requested": args.review,
                          "note": "Inspect saved calls for regression and review evidence."}))


if __name__ == "__main__":
    main()
