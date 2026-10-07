export interface User { id: string; name: string }

export function loadUser(): User {
  return { id: "u_1", name: "ada lovelace" };
}
