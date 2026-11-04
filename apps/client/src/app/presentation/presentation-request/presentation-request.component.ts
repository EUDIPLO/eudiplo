import { CommonModule } from '@angular/common';
import { inject, Component, type OnInit, ChangeDetectionStrategy } from '@angular/core';
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { OfferResponse, PresentationConfig, PresentationRequest } from '@eudiplo/sdk-core';
import { PresentationManagementService } from '../presentation-config/presentation-management.service';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { EditorComponent, extractSchema } from '../../utils/editor/editor.component';
import { transactionDataArraySchema } from '../../utils/schemas';
import { asSentence, getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { JwtService } from '../../services/jwt.service';

type ClientIdScheme = 'x509_hash' | 'x509_san_dns' | 'openid_federation';

type PresentationRequestWithClientIdScheme = PresentationRequest & {
  clientIdScheme?: ClientIdScheme;
};

@Component({
  selector: 'app-presentation-request',
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTooltipModule,
    FlexLayoutModule,
    RouterModule,
    ConfigOwnershipDirective,
    MatSlideToggleModule,
    EditorComponent,
  ],
  templateUrl: './presentation-request.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './presentation-request.component.scss',
})
export class PresentationRequestComponent implements OnInit {
  /** Origin the browser sends with the offer request, which the DC API call uses too. */
  readonly pageOrigin = window.location.origin;
  form: FormGroup;
  configs: PresentationConfig[] = [];
  loading = false;
  generatingOffer = false;
  checkingReadiness = false;
  readinessError: string | null = null;
  isReadyToGenerate = false;
  offerResult: OfferResponse | null = null;
  qrCodeDataUrl: string | null = null;
  showTransactionDataOverride = false;
  transactionDataArraySchema = transactionDataArraySchema;

  private readonly jwtService = inject(JwtService);

  /** Presentation configurations can be created with `presentation:manage`. */
  get canManagePresentationConfigs(): boolean {
    return this.jwtService.hasRole('presentation:manage');
  }

  /** Webhook endpoints can be opened with `issuance:manage` or `presentation:manage`. */
  get canManageWebhookEndpoints(): boolean {
    return this.jwtService.hasRole(['issuance:manage', 'presentation:manage']);
  }

  constructor(
    private presentationManagementService: PresentationManagementService,
    private snackBar: MatSnackBar,
    private router: Router,
    private route: ActivatedRoute
  ) {
    this.form = new FormGroup({
      requestId: new FormControl('', Validators.required),
      dcapi: new FormControl(false),
      clientIdScheme: new FormControl<ClientIdScheme>('x509_hash', { nonNullable: true }),
      transaction_data: new FormControl(undefined),
    });
  }

  ngOnInit(): void {
    this.form.get('requestId')?.valueChanges.subscribe((value) => {
      void this.evaluateReadiness(value || undefined);
    });
    this.loadConfigurations();
  }

  async loadConfigurations(): Promise<void> {
    this.loading = true;
    try {
      this.configs = await this.presentationManagementService.loadConfigurations();

      // Check for pre-fill data from navigation state (recreate offer flow)
      const prefillData = history.state?.presentationRequest as { requestId: string } | undefined;
      if (prefillData?.requestId) {
        this.form.patchValue({ requestId: prefillData.requestId });
        await this.evaluateReadiness(prefillData.requestId);
      } else if (this.route.snapshot.params['id']) {
        this.form.patchValue({ requestId: this.route.snapshot.params['id'] });
        await this.evaluateReadiness(this.route.snapshot.params['id']);
        //since we do not have any other values for now, we can submit the form
        this.onSubmit();
      } else {
        // Auto-select if only one configuration is available
        if (this.configs.length === 1) {
          this.form.patchValue({ requestId: this.configs[0].id });
        }
      }
    } catch (error) {
      console.error('Error loading configurations:', error);
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, 'Failed to load presentation configurations'),
        'Close',
        { panelClass: ['error-snackbar'] }
      );
    } finally {
      this.loading = false;
    }
  }

  /**
   * Why a DC API request for the selected configuration would be refused: the request names
   * this page's origin, and a configuration with allowedOrigins accepts only those.
   */
  get dcApiOriginProblem(): string | null {
    const config = this.selectedConfig;
    if (!this.form.get('dcapi')?.value || !config?.allowedOrigins?.length) return null;
    if (config.allowedOrigins.includes(this.pageOrigin)) return null;
    return `Presentation configuration "${config.id}" does not list this page's origin, ${this.pageOrigin}, under Allowed origins (Digital Credentials API).`;
  }

  get selectedConfig(): PresentationConfig | undefined {
    const selectedId = this.form.get('requestId')?.value;
    return this.configs.find((config) => config.id === selectedId);
  }

  private async evaluateReadiness(requestId?: string): Promise<void> {
    if (!requestId) {
      this.isReadyToGenerate = false;
      this.readinessError = null;
      return;
    }

    this.checkingReadiness = true;
    this.readinessError = null;

    try {
      const readiness =
        await this.presentationManagementService.checkPresentationReadiness(requestId);
      this.isReadyToGenerate = readiness.ready;
      this.readinessError = readiness.ready
        ? null
        : readiness.reason || 'Presentation cannot be generated with the current setup.';
    } catch (error) {
      console.error('Error checking presentation readiness:', error);
      this.isReadyToGenerate = false;
      this.readinessError = asSentence(
        getApiErrorMessage(error, 'Failed to validate presentation readiness')
      );
    } finally {
      this.checkingReadiness = false;
    }
  }

  async onSubmit(): Promise<void> {
    const requestId = this.form.get('requestId')?.value;
    await this.evaluateReadiness(requestId || undefined);

    if (this.dcApiOriginProblem) {
      this.snackBar.open(this.dcApiOriginProblem, 'Close', { duration: 5000 });
      return;
    }

    if (!this.isReadyToGenerate) {
      this.snackBar.open(this.readinessError || 'Presentation cannot be generated yet.', 'Close', {
        duration: 4000,
        panelClass: ['error-snackbar'],
      });
      return;
    }

    this.generatingOffer = true;
    this.offerResult = null;
    this.qrCodeDataUrl = null;

    try {
      const formValue = this.form.value;

      // Parse transaction_data if provided
      let transactionData = undefined;
      if (formValue.transaction_data) {
        try {
          transactionData = extractSchema(formValue.transaction_data);
        } catch (error) {
          console.error('Error parsing transaction_data JSON:', error);
          this.snackBar.open('Invalid transaction data JSON format', 'Close', {
            duration: 3000,
            panelClass: ['error-snackbar'],
          });
          this.generatingOffer = false;
          return;
        }
      }

      const offerRequest: PresentationRequestWithClientIdScheme = {
        requestId: formValue.requestId,
        response_type: formValue.dcapi ? 'dc-api' : 'uri',
        // The wallet is called from this page, so the request is bound to its origin.
        ...(formValue.dcapi && { expected_origin: this.pageOrigin }),
        ...(formValue.clientIdScheme &&
          formValue.clientIdScheme !== 'x509_hash' && {
            clientIdScheme: formValue.clientIdScheme as ClientIdScheme,
          }),
        ...(transactionData && { transaction_data: transactionData }),
      };

      const result = await this.presentationManagementService.getOffer(offerRequest);
      this.offerResult = result || null;

      this.snackBar.open(
        'Presentation request generated successfully! Redirecting to session details...',
        'Close',
        {
          duration: 2000,
          panelClass: ['success-snackbar'],
        }
      );

      // Redirect to session details page with QR code and polling enabled
      if (this.offerResult?.session) {
        this.router.navigate(['/session-management', this.offerResult!.session]);
      }
    } catch (error) {
      console.error('Error generating presentation request:', error);
      // The backend names a missing access certificate here.
      const message = getApiErrorMessage(error, 'Failed to generate presentation request');
      openErrorSnackBar(this.snackBar, message, 'Close', { panelClass: ['error-snackbar'] });
    } finally {
      this.generatingOffer = false;
    }
  }

  resetForm(): void {
    this.form.reset({
      requestId: '',
      dcapi: false,
      clientIdScheme: 'x509_hash',
      transaction_data: undefined,
    });
    this.readinessError = null;
    this.isReadyToGenerate = false;
    this.offerResult = null;
    this.qrCodeDataUrl = null;
  }

  downloadQRCode(): void {
    if (!this.qrCodeDataUrl) return;

    const link = document.createElement('a');
    link.download = `qr-code-${this.offerResult?.session || 'presentation'}.png`;
    link.href = this.qrCodeDataUrl;
    link.click();
  }
}
