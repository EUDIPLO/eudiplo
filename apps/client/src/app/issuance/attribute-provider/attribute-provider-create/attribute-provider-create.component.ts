import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { AttributeProviderService } from '../attribute-provider.service';
import { ApiKeyEndpointFormComponent } from '../../../common/api-key-endpoint-form';
import { LoadErrorComponent } from '../../../common/load-error.component';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';

@Component({
  selector: 'app-attribute-provider-create',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatDialogModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
  ],
  templateUrl: './attribute-provider-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './attribute-provider-create.component.scss',
})
export class AttributeProviderCreateComponent extends ApiKeyEndpointFormComponent {
  protected readonly noun = 'attribute provider';
  protected readonly detailsTitle = 'Provider Details';
  protected readonly jsonTitle = 'Attribute Provider JSON';

  constructor(
    service: AttributeProviderService,
    router: Router,
    route: ActivatedRoute,
    snackBar: MatSnackBar,
    dialog: MatDialog
  ) {
    super(service, router, route, snackBar, dialog);
  }
}
