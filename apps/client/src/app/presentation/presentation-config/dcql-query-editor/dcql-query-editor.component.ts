import { ChangeDetectionStrategy, Component, Input, OnDestroy, OnInit } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, ValidatorFn } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TrustList, trustListControllerGetAllTrustLists } from '@eudiplo/sdk-core';
import { Subscription } from 'rxjs';
import { EditorComponent } from '../../../utils/editor/editor.component';
import { DCQLSchema } from '../../../utils/schemas';
import {
  buildSimpleDcql,
  readSimpleDcql,
  SimpleCredentialQuery,
  SimpleDcql,
  ClaimQuery,
  TrustedAuthority,
  CredentialSetQuery,
  simpleDcqlError,
  onlyEmptyClaimsUnsupported,
  claimError,
  trustError,
  trustSummary,
} from './simple-dcql';
import { asSentence, getApiErrorMessage } from '../../../utils/error-message';
import { FederationTrustAnchorSelectComponent } from '../../../federation-trust-anchor/federation-trust-anchor-select/federation-trust-anchor-select.component';

@Component({
  selector: 'app-dcql-query-editor',
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    EditorComponent,
    FederationTrustAnchorSelectComponent,
  ],
  templateUrl: './dcql-query-editor.component.html',
  styleUrl: './dcql-query-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class DcqlQueryEditorComponent implements OnInit, OnDestroy {
  @Input({ required: true }) control!: FormControl;
  readonly schema = DCQLSchema;
  readonly claimError = claimError;
  readonly trustError = trustError;
  readonly trustSummary = trustSummary;
  query: SimpleDcql = { credentials: [] };
  jsonMode = false;
  supported = true;
  /** Only `claims: []` keeps the query out of the builder; the form error explains it. */
  onlyEmptyClaims = false;
  trustLists: TrustList[] = [];
  loadingTrustLists = false;
  trustListsError = '';
  private trustListsLoaded = false;
  private writing = false;
  private subscription?: Subscription;
  private readonly expandedPaths = new WeakSet<ClaimQuery>();
  readonly pastedClaims = new Map<SimpleCredentialQuery, string>();
  readonly pasteErrors = new Map<SimpleCredentialQuery, string>();
  private readonly visualValidator: ValidatorFn = () => {
    const error = this.supported && !this.jsonMode ? simpleDcqlError(this.query) : null;
    return error ? { simpleQuery: error } : null;
  };

  get credentials(): SimpleCredentialQuery[] {
    return this.query.credentials;
  }

  ngOnInit(): void {
    this.readValue();
    this.control.addValidators(this.visualValidator);
    this.control.updateValueAndValidity({ emitEvent: false });
    this.subscription = this.control.valueChanges.subscribe(() => {
      if (this.writing) return;
      this.readValue();
      this.control.updateValueAndValidity({ emitEvent: false });
    });
  }

  ngOnDestroy(): void {
    if (!this.subscription) return;
    this.subscription.unsubscribe();
    this.control.removeValidators(this.visualValidator);
    this.control.updateValueAndValidity({ emitEvent: false });
  }

  private readValue(): void {
    const query = readSimpleDcql(this.control.value);
    this.supported = query !== null;
    this.onlyEmptyClaims = !this.supported && onlyEmptyClaimsUnsupported(this.control.value);
    this.query = query ?? { credentials: [] };
    this.pastedClaims.clear();
    this.pasteErrors.clear();
    if (!this.supported) this.jsonMode = true;
  }

  setJsonMode(json: boolean): void {
    if (!json && !this.supported) return;
    this.jsonMode = json;
    this.control.updateValueAndValidity({ emitEvent: false });
  }

  addCredential(): void {
    let index = this.credentials.length + 1;
    while (this.credentials.some((credential) => credential.id === `credential_${index}`)) index++;
    this.credentials.push({
      id: `credential_${index}`,
      format: 'dc+sd-jwt',
      type: '',
      claims: [{ path: [''] }],
    });
    this.updateQuery();
  }

  removeCredential(index: number): void {
    const [credential] = this.credentials.splice(index, 1);
    this.pastedClaims.delete(credential);
    this.pasteErrors.delete(credential);
    // Keep references in sets: silently deleting them could weaken a requirement.
    this.updateQuery();
  }

  renameCredential(credential: SimpleCredentialQuery, id: string): void {
    const oldId = credential.id;
    if (
      id &&
      this.credentials.filter((entry) => entry.id === oldId).length === 1 &&
      !this.credentials.some((entry) => entry !== credential && entry.id === id)
    ) {
      for (const set of this.query.credentialSets ?? []) {
        set.options = set.options.map((option) => option.map((ref) => (ref === oldId ? id : ref)));
      }
    }
    credential.id = id;
    this.updateQuery();
  }

  changeFormat(credential: SimpleCredentialQuery, format: SimpleCredentialQuery['format']): void {
    credential.format = format;
    // Only adapt empty drafts; populated paths and options require an explicit user edit.
    for (const claim of credential.claims) {
      if (claim.path.every((part) => part === ''))
        claim.path = format === 'mso_mdoc' ? ['', ''] : [''];
    }
    this.updateQuery();
  }

  addClaim(credential: SimpleCredentialQuery): void {
    const namespace = credential.claims.find((claim) => claim.path.length === 2)?.path[0];
    credential.claims.push({
      path:
        credential.format === 'mso_mdoc'
          ? [typeof namespace === 'string' ? namespace : '', '']
          : [''],
    });
    this.updateQuery();
  }

  removeClaim(credential: SimpleCredentialQuery, index: number): void {
    credential.claims.splice(index, 1);
    this.updateQuery();
  }

  useSegments(claim: ClaimQuery): void {
    this.expandedPaths.add(claim);
  }

  usesSegments(claim: ClaimQuery, credential: SimpleCredentialQuery): boolean {
    return (
      this.expandedPaths.has(claim) ||
      (credential.format === 'dc+sd-jwt'
        ? claim.path.some((part) => typeof part !== 'string' || !/^[A-Za-z0-9_-]*$/.test(part))
        : claim.path.length !== 2 || claim.path.some((part) => typeof part !== 'string'))
    );
  }

  setClaimPath(claim: ClaimQuery, text: string): void {
    claim.path = text.split('.');
    this.updateQuery();
  }

  setSegmentKind(claim: ClaimQuery, index: number, kind: 'property' | 'index'): void {
    claim.path[index] = kind === 'index' ? 0 : String(claim.path[index]);
    this.updateQuery();
  }

  setArrayIndex(claim: ClaimQuery, index: number, value: number | null): void {
    claim.path[index] = value ?? Number.NaN;
    this.updateQuery();
  }

  setClaimId(claim: ClaimQuery, id: string): void {
    if (id) claim.id = id;
    else delete claim.id;
    this.updateQuery();
  }

  setRetention(claim: ClaimQuery, value: boolean | null): void {
    if (value === null) delete claim.intent_to_retain;
    else claim.intent_to_retain = value;
    this.updateQuery();
  }

  addAllowedValue(claim: ClaimQuery): void {
    (claim.values ??= []).push('');
    this.updateQuery();
  }
  removeAllowedValue(claim: ClaimQuery, index: number): void {
    claim.values?.splice(index, 1);
    if (!claim.values?.length) delete claim.values;
    this.updateQuery();
  }

  pasteClaims(credential: SimpleCredentialQuery): void {
    const text = this.pastedClaims.get(credential) ?? '';
    const paths = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split('.'));
    if (
      !paths.length ||
      paths.some((path) => path.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment)))
    ) {
      this.pasteErrors.set(credential, 'Enter one dot-separated claim path per line.');
      return;
    }
    for (const path of paths) {
      if (!credential.claims.some((claim) => JSON.stringify(claim.path) === JSON.stringify(path)))
        credential.claims.push({ path });
    }
    this.pastedClaims.delete(credential);
    this.pasteErrors.delete(credential);
    this.updateQuery();
  }

  async loadTrustLists(): Promise<void> {
    if (this.loadingTrustLists || this.trustListsLoaded) return;
    this.loadingTrustLists = true;
    this.trustListsError = '';
    try {
      const response = await trustListControllerGetAllTrustLists();
      this.trustLists = response.data ?? [];
      this.trustListsLoaded = true;
    } catch (error) {
      this.trustListsError = `${asSentence(getApiErrorMessage(error, 'Could not load managed trust lists'))} Existing references are preserved. Retry or add an external reference.`;
    } finally {
      this.loadingTrustLists = false;
    }
  }

  hasTrustList(id: string): boolean {
    return this.trustLists.some((list) => list.id === id);
  }

  addTrust(credential: SimpleCredentialQuery, kind: 'managed' | 'external' | 'federation'): void {
    const authorities = (credential.trustedAuthorities ??= []);
    if (kind === 'federation') authorities.push({ type: 'openid_federation', values: [''] });
    else {
      authorities.push({
        type: 'etsi_tl',
        values: [kind === 'managed' ? { trustListId: '' } : { url: '' }],
      });
      if (kind === 'managed') void this.loadTrustLists();
    }
    this.updateQuery();
  }

  selectTrustList(authority: TrustedAuthority, index: number, id: string): void {
    if (authority.type !== 'etsi_tl') return;
    authority.values[index] = { trustListId: id };
    this.updateQuery();
  }

  removeTrust(credential: SimpleCredentialQuery, authorityIndex: number, valueIndex: number): void {
    const authorities = credential.trustedAuthorities!;
    authorities[authorityIndex].values.splice(valueIndex, 1);
    if (!authorities[authorityIndex].values.length) authorities.splice(authorityIndex, 1);
    if (!authorities.length) delete credential.trustedAuthorities;
    this.updateQuery();
  }

  removeAuthority(credential: SimpleCredentialQuery, index: number): void {
    credential.trustedAuthorities?.splice(index, 1);
    if (!credential.trustedAuthorities?.length) delete credential.trustedAuthorities;
    this.updateQuery();
  }

  configureAlternatives(enabled: boolean): void {
    if (enabled)
      this.query.credentialSets = [
        { options: [this.credentials.map((credential) => credential.id)] },
      ];
    else delete this.query.credentialSets;
    this.updateQuery();
  }
  addRequirement(): void {
    this.query.credentialSets?.push({ options: [[]] });
    this.updateQuery();
  }
  removeRequirement(index: number): void {
    this.query.credentialSets?.splice(index, 1);
    this.updateQuery();
  }
  addOption(set: CredentialSetQuery): void {
    set.options.push([]);
    this.updateQuery();
  }
  removeOption(set: CredentialSetQuery, index: number): void {
    set.options.splice(index, 1);
    this.updateQuery();
  }
  missingIds(option: string[]): string[] {
    return option.filter((id) => !this.credentials.some((credential) => credential.id === id));
  }
  unreferencedIds(): string[] {
    const selected = new Set(this.query.credentialSets?.flatMap((set) => set.options.flat()) ?? []);
    return this.credentials.map((credential) => credential.id).filter((id) => !selected.has(id));
  }

  updateQuery(): void {
    this.writing = true;
    this.control.setValue(buildSimpleDcql(this.query));
    this.control.markAsDirty();
    this.control.markAsTouched();
    this.writing = false;
  }
}
