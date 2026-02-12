export function extractSelections(text: string): number[] {
  const nums = text.match(/\d+/g)?.map((n) => parseInt(n, 10)) ?? [];
  return Array.from(new Set(nums)).filter((n) => n >= 0);
}





