"""Exercise Pi's GPT/Claude handoff with synthetic files only."""

import argparse
import json
import queue
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path


def read_records(pipe, records):
    for line in iter(pipe.readline, b""):
        try:
            records.put(json.loads(line))
        except (ValueError, UnicodeDecodeError):
            records.put({"type": "invalid_record"})
    records.put({"type": "process_closed"})


def exchange(process, records, command, until_settled=False):
    command = {"id": secrets.token_hex(8), **command}
    process.stdin.write((json.dumps(command) + "\n").encode())
    process.stdin.flush()
    deadline = time.monotonic() + 180
    events = []
    accepted = False
    settled = False
    while time.monotonic() < deadline:
        event = records.get(timeout=max(0.1, deadline - time.monotonic()))
        if event["type"] in ("invalid_record", "process_closed"):
            raise RuntimeError(f"RPC failed: {event['type']}")
        events.append(event)
        if event["type"] == "response" and event.get("id") == command["id"]:
            if not event.get("success"):
                raise RuntimeError(event.get("error", "Command failed"))
            accepted = True
            if not until_settled:
                return event.get("data")
            if event.get("data", {}).get("disposition") != "started":
                raise RuntimeError("Expected prompt to start a new run")
        if event["type"] == "agent_settled":
            if event.get("aborted"):
                raise RuntimeError("Run aborted")
            settled = True
        if accepted and settled:
            return events
    raise TimeoutError("Pi did not settle within 180 seconds")


def inspect_turn(events, model, expected_file, expected_text):
    starts = [e for e in events if e["type"] == "tool_execution_start"]
    ends = [e for e in events if e["type"] == "tool_execution_end"]
    if expected_file is None:
        assert not starts, "Recall turn unexpectedly called a tool"
    else:
        assert len(starts) == len(ends) == 1, "Expected exactly one file read"
        call = starts[0]
        assert call["toolName"] == "read", call["toolName"]
        assert Path(call["args"]["path"]).name == expected_file
        assert call["toolCallId"] == ends[0]["toolCallId"]
        assert not ends[0].get("isError"), "Read failed"
        assert expected_text in json.dumps(ends[0]["result"])
    messages = [
        e["message"] for e in events
        if e["type"] == "message_end"
        and e["message"].get("role") == "assistant"
    ]
    assert messages, "Missing assistant response"
    final = messages[-1]
    assert final.get("model") == model, final.get("model")
    assert final.get("stopReason") not in ("error", "aborted")
    text = "".join(
        block["text"] for block in final["content"] if block["type"] == "text"
    ).strip()
    return {"model": model, "tool_calls": starts, "answer": text}


def run_check(bridge):
    pi = shutil.which("pi")
    if not pi or not bridge.is_file():
        raise RuntimeError("Install Pi and the project's pinned bridge first")
    alpha, beta = secrets.token_hex(12), secrets.token_hex(12)
    with tempfile.TemporaryDirectory(prefix="harness-handoff-") as directory:
        cwd = Path(directory)
        (cwd / "alpha.md").write_text(alpha)
        (cwd / "beta.md").write_text(beta)
        command = [
            pi, "--mode", "rpc", "--no-session", "--no-approve",
            "--no-extensions", "-e", str(bridge), "--tools", "read",
            "--no-mcp", "--no-skills", "--no-context-files",
            "--no-prompt-templates", "--model", "openai/gpt-6.1-sol",
        ]
        records = queue.Queue()
        with tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen(
                command, cwd=cwd, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=stderr,
            )
            reader = threading.Thread(
                target=read_records, args=(process.stdout, records), daemon=True,
            )
            reader.start()
            turns = []
            try:
                first = exchange(process, records, {
                    "type": "prompt",
                    "message": "Connectivity test with synthetic data. Read alpha.md "
                    "once using read. Remember its content, but do not quote it. "
                    "Reply only: Read alpha",
                }, True)
                turns.append(inspect_turn(first, "gpt-6.1-sol", "alpha.md", alpha))
                assert turns[-1]["answer"] == "Read alpha"
                (cwd / "alpha.md").unlink()
                exchange(process, records, {
                    "type": "set_model", "provider": "claude-bridge",
                    "modelId": "claude-opus-5-5",
                })
                second = exchange(process, records, {
                    "type": "prompt",
                    "message": "Read beta.md once using read. Recall alpha from the "
                    "earlier tool result; its file has been removed. Return only "
                    'a JSON object with keys "alpha" and "beta" and their contents.',
                }, True)
                turns.append(inspect_turn(
                    second, "claude-opus-5-5", "beta.md", beta,
                ))
                assert json.loads(turns[-1]["answer"]) == {"alpha": alpha, "beta": beta}
                (cwd / "beta.md").unlink()
                exchange(process, records, {
                    "type": "set_model", "provider": "openai",
                    "modelId": "gpt-6.1-sol",
                })
                third = exchange(process, records, {
                    "type": "prompt",
                    "message": "Both files are gone. Without tools, return only "
                    'a JSON object with the remembered "alpha" and "beta" values.',
                }, True)
                turns.append(inspect_turn(third, "gpt-6.1-sol", None, None))
                assert json.loads(turns[-1]["answer"]) == {"alpha": alpha, "beta": beta}
                return {"passed": True, "turns": turns}
            finally:
                process.stdin.close()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    bridge = args.bridge or (
        root / ".pi/npm/node_modules/pi-claude-bridge/src/index.ts"
    )
    print(json.dumps(run_check(bridge.resolve()), indent=2))


if __name__ == "__main__":
    main()
