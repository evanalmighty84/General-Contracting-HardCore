const KNOWN = [
  ['north richland hills', 'North Richland Hills', 'TX'],
  ['little elm', 'Little Elm', 'TX'],
  ['lowry crossing', 'Lowry Crossing', 'TX'],
  ['carrollton', 'Carrollton', 'TX'],
  ['richardson', 'Richardson', 'TX'],
  ['lewisville', 'Lewisville', 'TX'],
  ['grapevine', 'Grapevine', 'TX'],
  ['arlington', 'Arlington', 'TX'],
  ['mckinney', 'McKinney', 'TX'],
  ['mc kinney', 'McKinney', 'TX'],
  ['desoto', 'DeSoto', 'TX'],
  ['garland', 'Garland', 'TX'],
  ['frisco', 'Frisco', 'TX'],
  ['dallas', 'Dallas', 'TX'],
  ['plano', 'Plano', 'TX'],
  ['allen', 'Allen', 'TX'],
  ['prosper', 'Prosper', 'TX'],
  ['celina', 'Celina', 'TX'],
  ['melissa', 'Melissa', 'TX'],
  ['sachse', 'Sachse', 'TX'],
  ['mesquite', 'Mesquite', 'TX'],
];

const NEIGHBORHOODS = [
  ['craig ranch', 'McKinney', 'TX'],
  ['eldorado', 'McKinney', 'TX'],
  ['trinity falls', 'McKinney', 'TX'],
  ['stonebridge ranch', 'McKinney', 'TX'],
  ['westridge', 'McKinney', 'TX'],
  ['mckinney north', 'McKinney', 'TX'],
  ['villages of stonelake', 'Frisco', 'TX'],
];

module.exports = async function normalizeCity({ city, state, location, description }) {
  const combined = `${location || ''} ${description || ''} ${city || ''}`.toLowerCase();

  const explicit = String(location || '').match(/\b([A-Za-z .'-]+),\s*([A-Z]{2})\b/);
  if (explicit) return { city: explicit[1].trim(), state: explicit[2].toUpperCase() };

  for (const [needle, normalizedCity, normalizedState] of KNOWN) {
    if (combined.includes(needle)) return { city: normalizedCity, state: normalizedState };
  }

  for (const [needle, normalizedCity, normalizedState] of NEIGHBORHOODS) {
    if (combined.includes(needle)) return { city: normalizedCity, state: normalizedState };
  }

  return {
    city: city || null,
    state: state || process.env.LIGHTS_FALLBACK_STATE || 'TX',
  };
};
