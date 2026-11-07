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
import { WebhookEndpointService } from '../webhook-endpoint.service';
import { ApiKeyEndpointFormComponent } from '../../common/api-key-endpoint-form';
import { LoadErrorComponent } from '../../common/load-error.component';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';

@Component({
  selector: 'app-webhook-endpoint-create',
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
  templateUrl: './webhook-endpoint-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './webhook-endpoint-create.component.scss',
})
export class WebhookEndpointCreateComponent extends ApiKeyEndpointFormComponent {
  protected readonly noun = 'webhook endpoint';
  protected readonly detailsTitle = 'Endpoint Details';
  protected readonly jsonTitle = 'Webhook Endpoint JSON';

  constructor(
    service: WebhookEndpointService,
    router: Router,
    route: ActivatedRoute,
    snackBar: MatSnackBar,
    dialog: MatDialog
  ) {
    super(service, router, route, snackBar, dialog);
  }
}
