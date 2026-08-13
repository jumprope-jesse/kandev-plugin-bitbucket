import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default async function requirePackagedHost() {
  const baseURL = process.env.KANDEV_PLUGIN_E2E_URL?.replace(/\/$/, "");
  if (!baseURL) {
    throw new Error(
      "KANDEV_PLUGIN_E2E_URL is required. Provide a fresh disposable compatible Kandev host; this contract runner installs the freshly packaged plugin before testing it.",
    );
  }

  const manifest = await readFile(path.join(pluginRoot, "manifest.yaml"), "utf8");
  const id = manifest.match(/^id: "([^"]+)"$/m)?.[1];
  const version = manifest.match(/^version: "([^"]+)"$/m)?.[1];
  if (!id || !version) throw new Error("manifest.yaml must declare id and version for packaged E2E");

  const packagePath = process.env.KANDEV_PLUGIN_E2E_PACKAGE ?? path.join(pluginRoot, `${id}-${version}.tar.gz`);
  let archive;
  try {
    archive = await readFile(packagePath);
  } catch (error) {
    throw new Error(`Packaged E2E requires ${packagePath}; run make package-host first. ${String(error)}`);
  }

  const form = new FormData();
  form.set("package", new Blob([archive], { type: "application/gzip" }), path.basename(packagePath));
  const response = await fetch(`${baseURL}/api/plugins/install`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Could not install ${path.basename(packagePath)} into disposable host (${response.status}): ${await response.text()}`,
    );
  }

  const installed = await response.json();
  if (installed?.plugin?.id !== id || installed?.plugin?.status !== "active") {
    throw new Error(`Packaged plugin did not become active: ${JSON.stringify(installed)}`);
  }
}
