// Where the review's current hunk goes after a hunk is staged, unstaged or discarded. The diff is read
// again afterwards: in Unstaged or Staged the acted hunk is gone, so the next one has moved into its
// index; in All changes it stays (it is staged, still differs from HEAD), so the next one is at index+1.
// Returns the index of the hunk to focus in the same file, or -1 when the file has none left.
export function hunkAfterAction(before, after, hi) {
  if (after <= 0) return -1
  const next = after < before ? hi : hi + 1
  return Math.min(Math.max(next, 0), after - 1)
}
