import { CredentialConfigCreate } from '@eudiplo/sdk-core';

export interface PredefinedConfig {
  name: string;
  description: string;
  icon: string;
  config: CredentialConfigCreate;
}

type CredentialField = CredentialConfigCreate['fields'][number];

const field = (
  definition: Omit<CredentialField, 'display'>,
  englishName: string,
  germanName: string
): CredentialField => ({
  ...definition,
  display: [
    { locale: 'en', name: englishName },
    { locale: 'de', name: germanName },
  ],
});

export const configs: PredefinedConfig[] = [
  {
    name: 'PID (Personal Identity Document)',
    description: 'German Personal Identity Document configuration',
    icon: 'badge',
    config: {
      id: 'pid',
      description: 'Personal ID',
      config: {
        format: 'dc+sd-jwt',
        display: [
          {
            name: 'PID',
            description: 'PID Credential',
            locale: 'en',
            background_color: '#FFFFFF',
            text_color: '#000000',
          },
          {
            name: 'PID',
            description: 'PID Nachweis',
            locale: 'de',
            background_color: '#FFFFFF',
            text_color: '#000000',
          },
        ],
      },
      fields: [
        field(
          {
            path: ['address', 'country'],
            type: 'string',
            defaultValue: 'DE',
            mandatory: true,
            disclosable: true,
          },
          'Country',
          'Land'
        ),
        field(
          {
            path: ['address', 'locality'],
            type: 'string',
            defaultValue: 'KÖLN',
            mandatory: true,
            disclosable: true,
          },
          'City',
          'Ort'
        ),
        field(
          {
            path: ['address', 'postal_code'],
            type: 'string',
            defaultValue: '51147',
            mandatory: true,
            disclosable: true,
          },
          'Postal Code',
          'Postleitzahl'
        ),
        field(
          {
            path: ['address', 'street_address'],
            type: 'string',
            defaultValue: 'HEIDESTRAẞE 17',
            mandatory: true,
            disclosable: true,
          },
          'Street Address',
          'Strasse und Hausnummer'
        ),
        {
          path: ['address'],
          type: 'object',
          defaultValue: {
            street_address: 'HEIDESTRAẞE 17',
            locality: 'KÖLN',
            country: 'DE',
            postal_code: '51147',
          },
          disclosable: true,
          display: [
            {
              locale: 'en',
              name: 'Address',
            },
            {
              locale: 'de',
              name: 'Adresse',
            },
          ],
        },
        {
          path: ['age_birth_year'],
          type: 'integer',
          defaultValue: 1964,
          mandatory: true,
          disclosable: true,
          display: [
            {
              locale: 'en',
              name: 'Birth Year',
            },
            {
              locale: 'de',
              name: 'Geburtsjahr',
            },
          ],
        },
        field(
          {
            path: ['age_equal_or_over', '12'],
            type: 'boolean',
            defaultValue: true,
            mandatory: true,
            disclosable: false,
          },
          'Age 12 or Over',
          'Alter 12 oder aelter'
        ),
        field(
          {
            path: ['age_equal_or_over', '14'],
            type: 'boolean',
            defaultValue: true,
            mandatory: true,
            disclosable: false,
          },
          'Age 14 or Over',
          'Alter 14 oder aelter'
        ),
        field(
          {
            path: ['age_equal_or_over', '16'],
            type: 'boolean',
            defaultValue: true,
            mandatory: true,
            disclosable: false,
          },
          'Age 16 or Over',
          'Alter 16 oder aelter'
        ),
        field(
          {
            path: ['age_equal_or_over', '18'],
            type: 'boolean',
            defaultValue: true,
            mandatory: true,
            disclosable: false,
          },
          'Age 18 or Over',
          'Alter 18 oder aelter'
        ),
        field(
          {
            path: ['age_equal_or_over', '21'],
            type: 'boolean',
            defaultValue: true,
            mandatory: true,
            disclosable: false,
          },
          'Age 21 or Over',
          'Alter 21 oder aelter'
        ),
        field(
          {
            path: ['age_equal_or_over', '65'],
            type: 'boolean',
            defaultValue: false,
            mandatory: true,
            disclosable: false,
          },
          'Age 65 or Over',
          'Alter 65 oder aelter'
        ),
        {
          path: ['age_equal_or_over'],
          type: 'object',
          defaultValue: {
            '12': true,
            '14': true,
            '16': true,
            '18': true,
            '21': true,
            '65': false,
          },
          disclosable: true,
          display: [
            {
              locale: 'en',
              name: 'Age Assertions',
            },
            {
              locale: 'de',
              name: 'Altersangaben',
            },
          ],
        },
        {
          path: ['age_in_years'],
          type: 'integer',
          defaultValue: 61,
          mandatory: true,
          disclosable: true,
          display: [
            {
              locale: 'en',
              name: 'Age in Years',
            },
            {
              locale: 'de',
              name: 'Alter in Jahren',
            },
          ],
        },
        {
          path: ['birthdate'],
          type: 'string',
          defaultValue: '1964-08-12',
          mandatory: true,
          disclosable: true,
          display: [
            {
              locale: 'en',
              name: 'Birth Date',
            },
            {
              locale: 'de',
              name: 'Geburtsdatum',
            },
          ],
          constraints: {
            pattern: String.raw`^\d{4}-\d{2}-\d{2}$`,
          },
        },
        field(
          {
            path: ['family_name'],
            type: 'string',
            defaultValue: 'MUSTERMANN',
            mandatory: true,
            disclosable: true,
          },
          'Family Name',
          'Nachname'
        ),
        field(
          {
            path: ['given_name'],
            type: 'string',
            defaultValue: 'ERIKA',
            mandatory: true,
            disclosable: true,
          },
          'Given Name',
          'Vorname'
        ),
        field(
          {
            path: ['issuing_authority'],
            type: 'string',
            defaultValue: 'DE',
            mandatory: true,
            disclosable: true,
          },
          'Issuing Authority',
          'Ausstellende Behoerde'
        ),
        field(
          {
            path: ['issuing_country'],
            type: 'string',
            defaultValue: 'DE',
            mandatory: true,
            disclosable: true,
          },
          'Issuing Country',
          'Ausstellungsland'
        ),
        {
          path: ['nationalities', 0],
          type: 'string',
          defaultValue: 'DE',
          disclosable: false,
          display: [
            {
              locale: 'en',
              name: 'Nationality',
            },
            {
              locale: 'de',
              name: 'Staatsangehoerigkeit',
            },
          ],
        },
        {
          path: ['nationalities'],
          type: 'array',
          defaultValue: ['DE'],
          mandatory: true,
          disclosable: true,
          display: [
            {
              locale: 'en',
              name: 'Nationalities',
            },
            {
              locale: 'de',
              name: 'Staatsangehoerigkeiten',
            },
          ],
          constraints: {
            items: {
              type: 'string',
              title: 'Nationality',
            },
          },
        },
        {
          path: ['place_of_birth', 'locality'],
          type: 'string',
          defaultValue: 'BERLIN',
          mandatory: true,
          disclosable: false,
          display: [
            {
              locale: 'en',
              name: 'Place of Birth (City)',
            },
            {
              locale: 'de',
              name: 'Geburtsort (Stadt)',
            },
          ],
        },
        {
          path: ['place_of_birth'],
          type: 'object',
          defaultValue: {
            locality: 'BERLIN',
          },
          disclosable: true,
          display: [
            {
              locale: 'en',
              name: 'Place of Birth',
            },
            {
              locale: 'de',
              name: 'Geburtsort',
            },
          ],
        },
      ],
      vct: 'urn:eudi:pid:de:1',
      keyBinding: true,
      statusManagement: true,
      sdJwtTrustFormat: 'x5c',
      lifeTime: 604800,
    },
  },
];
