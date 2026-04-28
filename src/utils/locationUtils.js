export const normalizeOptionalText = (value) => {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed : null;
};

export const applyLocationFilters = (query, barcode, aisle, section, shelf) => {
  let nextQuery = query.eq("barcode", barcode).eq("aisle", aisle);

  if (section === null) {
    nextQuery = nextQuery.is("section", null);
  } else {
    nextQuery = nextQuery.eq("section", section);
  }

  if (shelf === null) {
    nextQuery = nextQuery.is("shelf", null);
  } else {
    nextQuery = nextQuery.eq("shelf", shelf);
  }

  return nextQuery;
};

export const calculateConfidenceScore = (confirmationCount) => {
  const count = Number(confirmationCount || 0);

  if (count <= 0) return 0;
  if (count === 1) return 35;
  if (count === 2) return 60;
  if (count === 3) return 78;
  if (count === 4) return 90;
  return 95;
};