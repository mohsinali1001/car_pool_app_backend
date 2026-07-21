function trimString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function sanitizeString(value, maxLen) {
  const s = trimString(value);
  if (maxLen && s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

function exceedsMaxLength(value, maxLen) {
  if (value == null) return false;
  return String(value).length > maxLen;
}

module.exports = {
  trimString,
  sanitizeString,
  exceedsMaxLength,
  MAX_CUSTOMER_MESSAGE: 500,
  MAX_LOCATION: 200,
  MAX_REVIEW: 1000,
};
