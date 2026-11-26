function createBb8Error(message, status, code, module = "auth") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.module = module;
  return error;
}

module.exports = {
  createBb8Error,
};
