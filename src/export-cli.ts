import { createExportBundle, resolveExportSettings } from "./exporter.js";

async function main(): Promise<void> {
  const settings = resolveExportSettings();
  console.log(`Creating sanitized Paperclip support export in ${settings.outputDir}...`);
  const result = await createExportBundle(settings);
  console.log(`Export ready: ${result.path} (${result.sizeBytes} bytes)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
