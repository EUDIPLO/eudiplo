import { MatTooltipModule } from '@angular/material/tooltip';
import {
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipInputEvent, MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

@Component({
  selector: 'app-credential-ids',
  imports: [
    MatTooltipModule,
    ReactiveFormsModule,
    MatCardModule,
    MatInputModule,
    MatIconModule,
    MatChipsModule,
    MatButtonModule,
  ],
  templateUrl: './credential-ids.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './credential-ids.component.scss',
})
export class CredentialIdsComponent implements OnInit {
  @Input() formGroup!: FormGroup;
  @Output() removeAttachment = new EventEmitter<void>();
  credentialIds = signal<string[]>([]);

  ngOnInit(): void {
    this.credentialIds.set(this.formGroup.get('credential_ids')?.value || []);
  }

  handleRemoveAttachment() {
    this.removeAttachment.emit();
  }

  addCredentialId($event: MatChipInputEvent) {
    const value = ($event.value || '').trim();
    if (value) {
      this.credentialIds.update((ids) => [...ids, value]);
    }
    $event.chipInput!.clear();
  }
  removeCredentialId(index: number) {
    this.credentialIds.update((ids) => ids.filter((_, i) => i !== index));
  }
}
