# Payments benchmark example

This small service is the fixed repository snapshot for the architecture, issue-localization, and execution-path evals. `POST /payments` crosses route registration, a controller, validation, a domain service, a repository, and a database adapter. It also contains one deliberate issue: lowercase supported currency codes are rejected by validation.
