// MITRE ATT&CK for ICS techniques the IDS sensor maps its alerts to.
// https://attack.mitre.org/matrices/ics/

export const ATTACK_ICS: Record<string, string> = {
  T0822: "External Remote Services",
  T0831: "Manipulation of Control",
  T0836: "Modify Parameter",
  T0846: "Remote System Discovery",
  T0855: "Unauthorized Command Message",
  T0880: "Loss of Safety",
  T0886: "Remote Services",
  T0888: "Remote System Information Discovery",
};

export function attackUrl(id: string): string {
  return `https://attack.mitre.org/techniques/${id}/`;
}

export function attackText(id: string): string {
  return `${id} ${ATTACK_ICS[id] ?? ""}`.trim();
}
