---
title: Client Development
---

# Client Development

The Angular client provides a management UI for credential configuration, presentation management, monitoring, and administration. It follows a feature-based structure with standalone components and a clear separation of concerns.

## Directory Map

```text
apps/client/src/app/
├── app.component.ts          # Root application component
├── app.config.ts             # Application-level providers and configuration
├── app.routes.ts             # Route definitions
├── core/                     # Core services and global functionality
│   ├── api.service.ts        # Backend API client wrapper
│   ├── oidc.service.ts       # OIDC authentication service
│   └── auth.interceptor.ts   # HTTP request authentication interceptor
├── services/                 # Shared application services
│   ├── environment.service.ts
│   ├── grafana-link.service.ts
│   └── jwt.service.ts
├── guards/                   # Route guards (authentication, authorization)
├── common/                   # Shared utilities and base components
├── utils/                    # Reusable UI components
│   ├── editor/               # JSON/code editor component
│   ├── image-field/          # Image upload/display component
│   └── webhook-config-*/     # Webhook configuration components
├── admin/                    # Administrative features
├── tenants/                  # Tenant management
├── users/                    # User management
├── issuance/                 # Credential issuance configuration
│   ├── credential-config/
│   ├── issuance-config/
│   ├── issuance-offer/
│   └── attribute-provider/
├── presentation/             # Presentation and verification configuration
│   └── presentation-config/
├── session-management/       # Active session monitoring
├── key-management/           # Key and KMS provider management
├── trust-list/               # Trust list configuration
├── status-list-*/            # Status list management
├── webhook-endpoint/         # Webhook endpoint management
├── registrar/                # Registrar configuration
└── schema-metadata/          # Schema metadata management
```

## Architecture Patterns

### Standalone Components

All components use the **standalone component** pattern introduced in Angular 15+. Components import their dependencies directly in the `imports` array:

```typescript
@Component({
    selector: "app-tenant-create",
    imports: [
        ReactiveFormsModule,
        MatCardModule,
        MatFormFieldModule,
        // ... other imports
    ],
    templateUrl: "./tenant-create.component.html",
    styleUrl: "./tenant-create.component.scss",
})
export class TenantCreateComponent {
    /* ... */
}
```

This eliminates the need for `NgModule` declarations in most cases.

### Smart vs. Dumb Components

The codebase follows the **smart/dumb component pattern**:

- **Smart components** (container components): Orchestrate data and business logic, interact with services, manage state, and handle routing. Examples: `TenantListComponent`, `SessionManagementListComponent`
- **Dumb components** (presentational components): Only receive data via `@Input()` and emit events via `@Output()`. They are pure UI components with no service dependencies. Examples: components in `utils/` folder

:::tip[Component Responsibility]
When creating a new component, decide whether it should be smart (owns logic) or dumb (only displays data). Keep dumb components truly stateless and dependency-free.
:::

### Reactive Forms

All forms **must use Reactive Forms** — template-driven forms are not allowed. Forms are constructed using `FormBuilder` and `FormGroup`:

```typescript
export class TenantCreateComponent {
    tenantForm: FormGroup;

    constructor(private readonly fb: FormBuilder) {
        this.tenantForm = this.fb.group({
            id: ["", [Validators.required]],
            name: ["", [Validators.required]],
            description: [""],
            roles: new FormControl<Role[]>(
                ["clients:manage"],
                [Validators.required],
            ),
        });
    }
}
```

### Generated API Client

The client uses a **generated TypeScript API client** from `@eudiplo/sdk-core`. Never make raw HTTP calls or hardcode API URLs:

```typescript
import {
    tenantControllerGetTenant,
    tenantControllerInitTenant,
    tenantControllerUpdateTenant,
} from "@eudiplo/sdk-core";
```

Regenerate the API client when backend endpoints change:

```bash
pnpm run gen:api
```

{/*TODO(verify): Confirm the exact command and where it's run from*/}

### State Management

State is managed in services using **RxJS patterns**:

- Use `BehaviorSubject` to hold state
- Expose state as `Observable` for consumption
- Services in `core/` and `services/` manage shared state

Example pattern:

```typescript
@Injectable({ providedIn: "root" })
export class MyStateService {
    private _data$ = new BehaviorSubject<DataType | null>(null);
    readonly data$ = this._data$.asObservable();

    updateData(data: DataType) {
        this._data$.next(data);
    }
}
```

{/*TODO(verify): Find actual examples of BehaviorSubject usage in the codebase for concrete patterns*/}

## Feature Organization

Features are organized by business capability, matching the backend structure:

- **Issuance**: Credential configuration, issuance configuration, attribute providers, and offer generation
- **Presentation**: Presentation configuration, verification rules, and credential requests
- **Key Management**: Key chains, KMS providers, and key rotation
- **Trust**: Trust list management and certificate validation
- **Sessions**: Active session monitoring and session configuration
- **Admin**: Users, tenants, clients, and audit logs

Each feature typically contains:

- **List component** (`*-list/`): Displays items in a table or grid
- **Show component** (`*-show/`): Displays details of a single item
- **Create/Edit component** (`*-create/`): Form for creating or editing items

## Development Workflow

### Running the Client

Start the development server:

```bash
pnpm --filter @eudiplo/client start
# or from the repository root
pnpm run dev  # starts all applications
```

The client runs on [http://localhost:4200](http://localhost:4200) by default.

### Code Quality Checks

Before submitting changes:

```bash
# Format code
pnpm --filter @eudiplo/client run format

# Check formatting
pnpm --filter @eudiplo/client run format:check

# Run linting
pnpm --filter @eudiplo/client run lint

# Build the application
pnpm --filter @eudiplo/client run build
```

### Testing

{/*TODO(verify): Confirm testing commands and patterns for the Angular client*/}

Run tests for the client:

```bash
pnpm --filter @eudiplo/client run test
```

## Material Design Components

The client uses **Angular Material** for UI components. Common imports include:

- `MatCardModule`, `MatButtonModule`, `MatFormFieldModule`
- `MatInputModule`, `MatSelectModule`, `MatTableModule`
- `MatDialogModule`, `MatSnackBar` for notifications
- `MatIconModule`, `MatTooltipModule`

Use Material components for consistency and accessibility.

## Adding a New Feature

When adding a new feature:

1. Create a feature folder under `apps/client/src/app/`
2. Create list, show, and create components as needed
3. Define routes in the feature or in `app.routes.ts`
4. Use the generated API client for backend communication
5. Follow reactive forms for all input collection
6. Separate smart (data-fetching) from dumb (UI-only) components
7. Add appropriate guards for authentication/authorization

## Related Documentation

- [Development Setup](./development-setup.md) — Environment configuration and running locally
- [Repository Structure](./development-setup.md#workspace-structure) — Monorepo layout and workspace conventions
- [Testing](./testing.md) — Writing and running tests
- [Backend Development](./backend-architecture.md#backend-development) — Understanding the API structure
