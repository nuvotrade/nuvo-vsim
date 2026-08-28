# Corporate-split limitation preserved intentionally

B5B closes the earnings half of CSP-FR-026 only.

The corporate-split branch still converts a date-only `executionDate` to `16:00:00Z`. No governing
document defines why that instant is correct, so B5B neither endorses nor changes it. Date-only split
semantics remain unresolved pending a Principal governance decision.

The exact pre-B5B split output fixture is:

```json
{"type":"CORPORATE_SPLIT","at":1788278400000,"source":"MASSIVE_ACTIONS"}
```

SHA-256:

```text
8e8893d716f8326b93c573a9c9827c115e69a3ee6680cbb99007c2d92c2e0aed
```

The post-B5B provider output serializes to the same bytes and hash. The test uses the fixed literal;
it does not compute both expectations from the current mapper.

Finding disposition after B5B:

```text
CSP-FR-026 earnings half  RESOLVED_BUILT_NOT_DEPLOYED
CSP-FR-026 split half     OPEN_GOVERNANCE
```

