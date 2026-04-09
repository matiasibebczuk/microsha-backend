function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isSanctionsEnabled() {
  return parseBoolean(process.env.SANCTIONS_ENABLED, false);
}

module.exports = {
  isSanctionsEnabled,
};
