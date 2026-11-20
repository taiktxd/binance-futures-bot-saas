window.EXTREME_CONFIG = {
  API_URL: ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:8080"
    : "",
  STATIC_IP: "203.0.113.10"
};
