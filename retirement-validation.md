# Disposable retirement validation — do not merge

This diagnostic fixture supports one disposable-worker retirement, attachment
preservation, and reopen test. It is not a production change or approval.

- Owner: `T-01a1c8dd-a691-7283-9481-e3d6d4b3160c`
- Sole disposable worker: `T-01a1ccbe-6ba9-71bc-a011-3b20241cf7d2`
- No full review workflow or additional workers are part of this validation.
- Existing workers and relay scopes remain untouched. Retirement requires
  separate verification of the disposable worker's exact identity.

Keep the diagnostic PR in draft and do not merge it. Its comments are diagnostic
evidence, not review approval for production code.
