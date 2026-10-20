import { writeFileSync } from "node:fs";

import { OPT_OUT_ACK } from "../../src/agent/inbound.ts";
import { ACME_STUDIO } from "../../src/config.ts";
import { createFrontDeskRegistry } from "../../src/tools/booking-tools.ts";

/**
 * Export the specs the Python checks score against: tool JSON schemas (from
 * the same zod definitions the agent uses), the approved facts, and the
 * opt-out acknowledgment. Never hand-edited.
 *
 *   tsx evals/runner/export-specs.ts evals/data/specs.json
 */
const toolSchemas = Object.fromEntries(createFrontDeskRegistry().specs().map((s) => [s.function.name, s.function.parameters]));
const specs = { studio: { name: ACME_STUDIO.name, timeZone: ACME_STUDIO.timeZone, rooms: ACME_STUDIO.rooms }, faqFacts: ACME_STUDIO.facts, optOutAck: OPT_OUT_ACK, toolSchemas };
const out = process.argv[2] ?? "evals/data/specs.json";
writeFileSync(out, JSON.stringify(specs, null, 2) + "\n");
console.log(`wrote ${out}`);
