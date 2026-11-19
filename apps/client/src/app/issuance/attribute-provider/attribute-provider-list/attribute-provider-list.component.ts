import { Component, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { AttributeProviderEntity } from '@eudiplo/sdk-core';
import { getApiKeyAuthType } from '../../../common/auth-display.util';
import { BaseAsyncListComponent } from '../../../common/base-async-list.component';
import { AttributeProviderService } from '../attribute-provider.service';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { LoadErrorComponent } from '../../../common/load-error.component';

@Component({
  selector: 'app-attribute-provider-list',
  imports: [
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatCardModule,
    MatTooltipModule,
    FormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    LoadErrorComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './attribute-provider-list.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './attribute-provider-list.component.scss',
})
export class AttributeProviderListComponent extends BaseAsyncListComponent<AttributeProviderEntity> {
  protected readonly loadFailedMessage = 'Failed to load attribute providers';

  get providers(): AttributeProviderEntity[] {
    return this.items;
  }

  /** The provider column also shows the ID. */
  displayedColumns: string[] = ['id', 'url', 'auth', 'actions'];

  constructor(private readonly attributeProviderService: AttributeProviderService) {
    super();
  }

  protected fetchItems(): Promise<AttributeProviderEntity[]> {
    return this.attributeProviderService.getAll();
  }

  protected override searchTexts(provider: AttributeProviderEntity): string[] {
    return [provider.id, provider.name ?? '', provider.url ?? ''];
  }

  protected override sortName(provider: AttributeProviderEntity): string {
    return provider.name || provider.id;
  }

  getAuthType(provider: AttributeProviderEntity): string {
    return getApiKeyAuthType(provider.auth as { type?: string });
  }

  deleteProvider(provider: AttributeProviderEntity): Promise<void> {
    return this.deleteItem({
      item: provider,
      id: provider.id,
      question: `Delete attribute provider "${provider.name || provider.id}"? This cannot be undone.`,
      request: () => this.attributeProviderService.delete(provider.id),
      deleted: 'Attribute provider deleted successfully',
      failed: 'Failed to delete attribute provider',
    });
  }
}
