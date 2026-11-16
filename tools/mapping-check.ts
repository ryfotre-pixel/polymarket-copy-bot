// Sanity sweep: for every upcoming game, does the bot map each international team to the US side
// whose price agrees? A big disagreement on a liquid game means the teams got swapped.
import { snapshot } from './price-gap.ts';

const rows = await snapshot();
const liquid = rows.filter((r) => r.intlSpread !== undefined && r.intlSpread <= 0.05 && r.usAsk !== undefined && r.usBid !== undefined);
const bad = liquid.filter((r) => Math.abs((r.usAsk! + r.usBid!) / 2 - r.intlMid!) > 0.15);
console.log(`${rows.length / 2} games, ${liquid.length} liquid sides checked, ${bad.length} look swapped`);
for (const r of bad) console.log(`  SWAPPED? ${r.event} ${r.team} -> ${r.usSlug} ${r.side}: US mid ${((r.usAsk! + r.usBid!) / 2).toFixed(3)} vs intl ${r.intlMid!.toFixed(3)}`);
const gaps = liquid.filter((r) => (r.edgeVsIntl ?? 0) >= 0.02).sort((a, b) => b.edgeVsIntl! - a.edgeVsIntl!);
console.log(`\nliquid sides where US ask is >=2c below the intl mid: ${gaps.length} of ${liquid.length}`);
for (const r of gaps) console.log(`  ${r.event.padEnd(28)} ${r.team.slice(0, 22).padEnd(22)} US ask ${r.usAsk!.toFixed(3)}  intl mid ${r.intlMid!.toFixed(3)} (spread ${r.intlSpread!.toFixed(3)})  gap ${(r.edgeVsIntl! * 100).toFixed(1)}c`);
