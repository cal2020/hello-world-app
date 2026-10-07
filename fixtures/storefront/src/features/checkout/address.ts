export function validateAddress(a: string) {
  if (a.trim().length < 5) throw new Error("Address too short");
}
