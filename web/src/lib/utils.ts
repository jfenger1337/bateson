// Joins class names, skipping the empty ones. shadcn's cn() also merges Tailwind classes; there is no
// Tailwind here, so a join is all it needs to be.
export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}
