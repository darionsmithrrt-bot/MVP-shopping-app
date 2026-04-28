export const isIgnorablePlayInterruption = (err) => {
  const message = String(err?.message || err || "").toLowerCase();

  return (
    err?.name === "AbortError" ||
    message.includes("play() request was interrupted") ||
    message.includes("the play request was interrupted") ||
    message.includes("interrupted by a new load request")
  );
};
