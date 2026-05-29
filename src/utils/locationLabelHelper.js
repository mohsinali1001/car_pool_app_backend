function clean(value) {
  const text = (value ?? '').toString().trim();
  return text === '[object Object]' ? '' : text;
}

function labelFromLocation(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return clean(value);
  }
  if (typeof value !== 'object') return clean(value);

  const directKeys = [
    'formattedAddress',
    'formatted_address',
    'description',
    'name',
    'address',
    'label',
    'placeName',
    'text',
  ];
  for (const key of directKeys) {
    const label = clean(value[key]);
    if (label) return label;
  }

  const parts = [
    value.street,
    value.subLocality,
    value.sublocality,
    value.locality,
    value.city,
    value.administrativeArea,
    value.state,
    value.country,
  ]
    .map(clean)
    .filter(Boolean);

  return parts.length ? [...new Set(parts)].join(', ') : '';
}

module.exports = { clean, labelFromLocation };
