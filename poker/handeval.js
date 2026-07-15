// Poker hand evaluation. Cards are { rank, suit } where rank is 2..14
// (11=J, 12=Q, 13=K, 14=A) and suit is 0..3.
//
// evaluate7(cards) returns the best 5-card hand as a comparable score:
//   { category, ranks, name } where higher category wins, and `ranks`
//   breaks ties within a category (compare element by element).

const CATEGORY_NAMES = [
  "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
  "Flush", "Full House", "Four of a Kind", "Straight Flush",
];

function score5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);

  const isFlush = suits.every((s) => s === suits[0]);

  // Count occurrences of each rank.
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // Sort ranks by (count desc, rank desc) for tie-break ordering.
  const grouped = Object.keys(counts)
    .map(Number)
    .sort((a, b) => counts[b] - counts[a] || b - a);
  const countValues = grouped.map((r) => counts[r]).sort((a, b) => b - a);

  // Straight detection (including wheel A-2-3-4-5).
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }

  let category, tiebreak;
  if (straightHigh && isFlush) { category = 8; tiebreak = [straightHigh]; }
  else if (countValues[0] === 4) { category = 7; tiebreak = grouped; }
  else if (countValues[0] === 3 && countValues[1] === 2) { category = 6; tiebreak = grouped; }
  else if (isFlush) { category = 5; tiebreak = ranks; }
  else if (straightHigh) { category = 4; tiebreak = [straightHigh]; }
  else if (countValues[0] === 3) { category = 3; tiebreak = grouped; }
  else if (countValues[0] === 2 && countValues[1] === 2) { category = 2; tiebreak = grouped; }
  else if (countValues[0] === 2) { category = 1; tiebreak = grouped; }
  else { category = 0; tiebreak = ranks; }

  return { category, ranks: tiebreak, name: CATEGORY_NAMES[category] };
}

function compareScore(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.ranks.length, b.ranks.length);
  for (let i = 0; i < len; i++) {
    const d = (a.ranks[i] || 0) - (b.ranks[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Generate all k-combinations of an array's indices.
function combinations(arr, k) {
  const result = [];
  const combo = [];
  (function pick(start) {
    if (combo.length === k) { result.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      pick(i + 1);
      combo.pop();
    }
  })(0);
  return result;
}

function evaluate7(cards) {
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const s = score5(combo);
    if (!best || compareScore(s, best) > 0) best = s;
  }
  return best;
}

window.HandEval = { evaluate7, compareScore, CATEGORY_NAMES };
