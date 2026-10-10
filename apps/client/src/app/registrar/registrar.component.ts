import { CommonModule } from '@angular/common';
import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { RegistrarConfig, RegistrarConfigRequest, RegistrarService } from './registrar.service';
import { ConfigOwnershipDirective } from '../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../config-portability/config-ownership-notice.component';

interface RegistrarPreset {
  name: string;
  registrarUrl: string;
  oidcUrl: string;
  clientId: string;
  clientSecret?: string;
}

@Component({
  selector: 'app-registrar',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
  ],
  templateUrl: './registrar.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './registrar.component.scss',
})
export class RegistrarComponent implements OnInit {
  configForm: FormGroup;
  config: RegistrarConfig | null = null;
  selectedPreset = '';

  isLoading = true;
  isSaving = false;
  showPassword = false;

  readonly presets: RegistrarPreset[] = [
    {
      name: 'German Sandbox',
      registrarUrl: 'https://sandbox.eudi-wallet.org/api',
      oidcUrl: 'https://auth.sandbox.eudi-wallet.org/realms/sandbox-registrar',
      clientId: 'swagger',
    },
  ];

  constructor(
    private readonly registrarService: RegistrarService,
    private readonly snackBar: MatSnackBar,
    private readonly fb: FormBuilder
  ) {
    this.configForm = this.fb.group({
      registrarUrl: ['', [Validators.required]],
      oidcUrl: ['', [Validators.required]],
      clientId: ['', [Validators.required]],
      clientSecret: [''],
      username: ['', [Validators.required]],
      password: ['', [Validators.required]],
      registrationCertificateDefaults: this.fb.group({
        privacy_policy: [''],
        support_uri: [''],
        intermediary: [''],
      }),
    });
  }

  ngOnInit(): void {
    this.loadData();
  }

  async loadData(): Promise<void> {
    this.isLoading = true;
    try {
      this.config = await this.registrarService.getConfig();

      if (this.config) {
        this.configForm.patchValue({
          registrarUrl: this.config.registrarUrl,
          oidcUrl: this.config.oidcUrl,
          clientId: this.config.clientId,
          clientSecret: '', // Never returned; user must enter a new one to change it
          username: this.config.username,
          password: '', // Password is never returned; user must enter new one to change it
          registrationCertificateDefaults: {
            privacy_policy:
              typeof this.config.registrationCertificateDefaults?.['privacy_policy'] === 'string'
                ? this.config.registrationCertificateDefaults?.['privacy_policy']
                : '',
            support_uri:
              typeof this.config.registrationCertificateDefaults?.['support_uri'] === 'string'
                ? this.config.registrationCertificateDefaults?.['support_uri']
                : '',
            intermediary:
              typeof this.config.registrationCertificateDefaults?.['intermediary'] === 'string'
                ? this.config.registrationCertificateDefaults?.['intermediary']
                : '',
          },
        });
        // If config exists with a password, password field is optional (keep existing)
        if (this.config.hasPassword) {
          this.configForm.get('password')?.clearValidators();
          this.configForm.get('password')?.updateValueAndValidity();
        }
      }
    } catch (error) {
      console.error('Error loading registrar data:', error);
      this.snackBar.open('Failed to load registrar data', 'Close', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  async saveConfig(): Promise<void> {
    if (this.configForm.invalid) {
      this.snackBar.open('Please fill in all required fields', 'Close', { duration: 3000 });
      return;
    }

    const formValue = this.configForm.value;
    const isUpdate = this.config !== null;

    // Password is required for new config
    if (!isUpdate && !formValue.password) {
      this.snackBar.open('Password is required for new configuration', 'Close', { duration: 3000 });
      return;
    }

    this.isSaving = true;
    try {
      const configRequest: RegistrarConfigRequest = {
        registrarUrl: formValue.registrarUrl,
        oidcUrl: formValue.oidcUrl,
        clientId: formValue.clientId,
        clientSecret: formValue.clientSecret || undefined,
        username: formValue.username,
      };

      const defaultsGroup = formValue.registrationCertificateDefaults || {};
      const registrationCertificateDefaults: Record<string, unknown> = {};

      if (defaultsGroup['privacy_policy']?.trim()) {
        registrationCertificateDefaults['privacy_policy'] = defaultsGroup['privacy_policy'].trim();
      }
      if (defaultsGroup['support_uri']?.trim()) {
        registrationCertificateDefaults['support_uri'] = defaultsGroup['support_uri'].trim();
      }
      if (defaultsGroup['intermediary']?.trim()) {
        registrationCertificateDefaults['intermediary'] = defaultsGroup['intermediary'].trim();
      }

      if (Object.keys(registrationCertificateDefaults).length > 0) {
        configRequest.registrationCertificateDefaults = registrationCertificateDefaults;
      } else {
        configRequest.registrationCertificateDefaults = null;
      }

      // Only include password if user entered one (for updates) or always for new config
      if (formValue.password) {
        configRequest.password = formValue.password;
      }

      if (isUpdate) {
        // Use PATCH for updates - only send fields that should be updated
        this.config = await this.registrarService.updateConfig(configRequest);
      } else {
        // Use POST for new config
        this.config = await this.registrarService.saveConfig(configRequest);
      }
      this.snackBar.open('Configuration saved successfully', 'Close', { duration: 3000 });
    } catch (error: any) {
      console.error('Error saving config:', error);
      const message = error.error?.message || 'Failed to save configuration';
      this.snackBar.open(message, 'Close', { duration: 5000 });
    } finally {
      this.isSaving = false;
    }
  }

  async deleteConfig(): Promise<void> {
    if (!confirm('Are you sure you want to delete the registrar configuration?')) {
      return;
    }

    this.isSaving = true;
    try {
      await this.registrarService.deleteConfig();
      this.config = null;
      this.configForm.reset();
      this.snackBar.open('Configuration deleted', 'Close', { duration: 3000 });
    } catch (error) {
      console.error('Error deleting config:', error);
      this.snackBar.open('Failed to delete configuration', 'Close', { duration: 3000 });
    } finally {
      this.isSaving = false;
    }
  }

  get hasConfig(): boolean {
    return this.config !== null;
  }

  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  applyPreset(presetName: string): void {
    const preset = this.presets.find((p) => p.name === presetName);
    if (preset) {
      this.configForm.patchValue({
        registrarUrl: preset.registrarUrl,
        oidcUrl: preset.oidcUrl,
        clientId: preset.clientId,
        clientSecret: preset.clientSecret || '',
      });
      this.snackBar.open(
        `Applied "${preset.name}" preset. Please enter your credentials.`,
        'Close',
        {
          duration: 3000,
        }
      );
    }
  }
}
