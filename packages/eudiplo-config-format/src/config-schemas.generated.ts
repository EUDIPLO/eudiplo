// Generated from schemas/v*/. Run pnpm schemas:sync.
export const CONFIG_SCHEMAS: Record<string, any>[] = [
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/AttributeProviderConfigFile.schema.json",
    "title": "AttributeProviderConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/AttributeProviderConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "allOf": [
          {
            "$ref": "#/$defs/CreateAttributeProviderDto"
          },
          {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        ]
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "CreateAttributeProviderDto": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "description": "Unique attribute provider identifier."
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "description": "Display name of the attribute provider."
          },
          "description": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ],
            "description": "Optional attribute provider description."
          },
          "url": {
            "type": "string",
            "format": "uri",
            "description": "Base URL of the attribute provider endpoint."
          },
          "auth": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "none",
                    "description": "Disable authentication for attribute provider calls."
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false,
                "description": "No authentication variant."
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "apiKey",
                    "description": "Use API key authentication."
                  },
                  "config": {
                    "type": "object",
                    "properties": {
                      "headerName": {
                        "type": "string",
                        "minLength": 1,
                        "description": "HTTP header name carrying the API key."
                      },
                      "value": {
                        "type": "string",
                        "minLength": 1,
                        "description": "API key value."
                      }
                    },
                    "required": [
                      "headerName",
                      "value"
                    ],
                    "additionalProperties": false,
                    "description": "API key authentication settings."
                  }
                },
                "required": [
                  "type",
                  "config"
                ],
                "additionalProperties": false,
                "description": "API key authentication variant."
              }
            ],
            "description": "Authentication configuration for outbound provider requests."
          }
        },
        "required": [
          "id",
          "name",
          "url",
          "auth"
        ],
        "additionalProperties": false,
        "title": "CreateAttributeProviderDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/ClientConfigFile.schema.json",
    "title": "ClientConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/ClientConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "allOf": [
          {
            "$ref": "#/$defs/CreateClientDto"
          },
          {
            "type": "object",
            "required": [
              "clientId"
            ],
            "properties": {
              "clientId": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        ]
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "CreateClientDto": {
        "type": "object",
        "properties": {
          "clientId": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "description": "Unique client identifier."
          },
          "secret": {
            "description": "Optional client secret for confidential clients.",
            "type": "string",
            "minLength": 1
          },
          "description": {
            "description": "Optional human-readable client description.",
            "type": "string",
            "minLength": 1
          },
          "roles": {
            "minItems": 1,
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "presentation:manage",
                "presentation:request",
                "issuance:manage",
                "issuance:offer",
                "clients:manage",
                "users:manage",
                "tenants:manage",
                "tenant:admin",
                "registrar:manage"
              ]
            },
            "description": "Roles assigned to the client. At least one role is required."
          },
          "allowedPresentationConfigs": {
            "description": "Optional allow-list of presentation config ids this client can use.",
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "allowedIssuanceConfigs": {
            "description": "Optional allow-list of issuance config ids this client can use.",
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "clientId",
          "roles"
        ],
        "additionalProperties": false,
        "title": "CreateClientDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/CredentialConfigFile.schema.json",
    "title": "CredentialConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/CredentialConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "allOf": [
          {
            "$ref": "#/$defs/CredentialConfigCreate"
          },
          {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        ]
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "CredentialConfigCreate": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "description": "Credential configuration identifier."
          },
          "description": {
            "description": "Optional description for operators and tooling.",
            "type": [
              "string",
              "null"
            ]
          },
          "config": {
            "type": "object",
            "properties": {
              "format": {
                "type": "string",
                "enum": [
                  "mso_mdoc",
                  "dc+sd-jwt"
                ],
                "description": "Credential format emitted by this configuration."
              },
              "display": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "locale": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Locale tag for the display entry."
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Human-readable field name."
                    },
                    "description": {
                      "description": "Optional field description for this locale.",
                      "type": "string"
                    },
                    "background_color": {
                      "description": "Optional background color for card-style rendering.",
                      "type": "string"
                    },
                    "text_color": {
                      "description": "Optional text color for card-style rendering.",
                      "type": "string"
                    },
                    "background_image": {
                      "description": "Optional background image.",
                      "type": "object",
                      "properties": {
                        "uri": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Image URI."
                        }
                      },
                      "required": [
                        "uri"
                      ],
                      "additionalProperties": false
                    },
                    "logo": {
                      "description": "Optional logo image.",
                      "type": "object",
                      "properties": {
                        "uri": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Image URI."
                        }
                      },
                      "required": [
                        "uri"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "locale",
                    "name"
                  ],
                  "additionalProperties": false
                },
                "description": "Display metadata shown by wallets."
              },
              "scope": {
                "description": "Optional OAuth scope associated with this credential type.",
                "type": "string"
              },
              "docType": {
                "description": "Optional mDoc document type.",
                "type": "string"
              },
              "keyAttestationsRequired": {
                "description": "Optional key attestation requirements.",
                "type": "object",
                "properties": {
                  "key_storage": {
                    "description": "Required key storage attestations.",
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "user_authentication": {
                    "description": "Required user authentication attestations.",
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  }
                },
                "additionalProperties": false
              },
              "proofTypesSupported": {
                "description": "Supported proof types for issuance requests.",
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "jwt",
                    "attestation"
                  ]
                }
              },
              "credentialReusePolicy": {
                "description": "Optional PID/EAA reuse policy published in credential metadata.",
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "options": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "details": {
                          "minItems": 1,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "once_only",
                              "limited_time",
                              "limited-time",
                              "rotating-batch",
                              "per-relying-party"
                            ]
                          }
                        },
                        "batch_size": {
                          "type": "integer",
                          "minimum": 2,
                          "maximum": 9007199254740991
                        },
                        "reissue_trigger_unused": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "reissue_trigger_lifetime_left": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        }
                      },
                      "required": [
                        "details"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "id"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "format",
              "display"
            ],
            "additionalProperties": false,
            "description": "Issuer metadata-facing credential configuration."
          },
          "fields": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/CredentialConfigCreate/$defs/__schema0"
            },
            "description": "Claim field definitions for credential issuance."
          },
          "attributeProviderId": {
            "description": "Optional attribute provider id used to resolve claim values.",
            "type": [
              "string",
              "null"
            ]
          },
          "webhookEndpointId": {
            "description": "Optional webhook endpoint id notified during issuance events.",
            "type": [
              "string",
              "null"
            ]
          },
          "vct": {
            "description": "Optional VCT value or structured VCT metadata.",
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "properties": {
                  "vct": {
                    "description": "VCT identifier.",
                    "type": "string"
                  },
                  "name": {
                    "description": "Human-readable VCT name.",
                    "type": "string"
                  },
                  "description": {
                    "description": "Optional VCT description.",
                    "type": "string"
                  },
                  "extends": {
                    "description": "Optional base VCT reference.",
                    "type": "string"
                  },
                  "extends#integrity": {
                    "description": "Integrity hash for the extends reference.",
                    "type": "string"
                  },
                  "schema_uri": {
                    "description": "Optional schema URI for the VCT.",
                    "type": "string"
                  },
                  "schema_uri#integrity": {
                    "description": "Integrity hash for schema_uri.",
                    "type": "string"
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "keyBinding": {
            "description": "Enable key binding requirements.",
            "type": "boolean"
          },
          "keyChainId": {
            "description": "Optional key chain id used for credential signing.",
            "type": "string",
            "minLength": 1
          },
          "statusManagement": {
            "description": "Enable status management for issued credentials.",
            "type": "boolean"
          },
          "activeCredentials": {
            "description": "Optional issuer-side policy limiting simultaneously active credentials per subject. Requires statusManagement.",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "enabled": {
                    "type": "boolean",
                    "description": "Ensure a subject has at most one active credential of this configuration."
                  },
                  "tracking": {
                    "description": "How the subject's active credential set is tracked. Only 'internal' (pseudonymous, issuer-side) is currently supported.",
                    "type": "string",
                    "enum": [
                      "internal"
                    ]
                  }
                },
                "required": [
                  "enabled"
                ],
                "additionalProperties": false,
                "description": "Issuer-side policy limiting the number of simultaneously active credentials per subject."
              },
              {
                "type": "null"
              }
            ]
          },
          "iaeActions": {
            "description": "Optional in-app experience actions for wallet flows.",
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "type": {
                          "type": "string",
                          "const": "openid4vp_presentation",
                          "description": "Trigger an OpenID4VP presentation action."
                        },
                        "label": {
                          "description": "Optional UI label for the action.",
                          "type": "string"
                        },
                        "presentationConfigId": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Presentation configuration id to execute."
                        }
                      },
                      "required": [
                        "type",
                        "presentationConfigId"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "type": {
                          "type": "string",
                          "const": "redirect_to_web",
                          "description": "Trigger a redirect-to-web action."
                        },
                        "label": {
                          "description": "Optional UI label for the action.",
                          "type": "string"
                        },
                        "url": {
                          "type": "string",
                          "format": "uri",
                          "description": "Destination URL for the redirect action."
                        },
                        "callbackUrl": {
                          "description": "Optional callback URL after redirect completion.",
                          "type": "string",
                          "format": "uri"
                        },
                        "description": {
                          "description": "Optional action description.",
                          "type": "string"
                        }
                      },
                      "required": [
                        "type",
                        "url"
                      ],
                      "additionalProperties": false
                    }
                  ],
                  "description": "In-app experience action definitions."
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "sdJwtTrustFormat": {
            "description": "Trust format used for SD-JWT verification metadata.",
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "x5c",
                  "federation"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "lifeTime": {
            "description": "Credential lifetime in seconds.",
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "schemaMeta": {
            "description": "Optional schema metadata and trust bindings.",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "id": {
                    "description": "Optional schema metadata identifier.",
                    "type": "string"
                  },
                  "name": {
                    "description": "Optional schema metadata name.",
                    "type": "string"
                  },
                  "version": {
                    "type": "string",
                    "description": "Schema metadata version."
                  },
                  "rulebookURI": {
                    "description": "Optional rulebook URI reference.",
                    "type": "string"
                  },
                  "attestationLoS": {
                    "type": "string",
                    "enum": [
                      "iso_18045_high",
                      "iso_18045_moderate",
                      "iso_18045_enhanced-basic",
                      "iso_18045_basic"
                    ],
                    "description": "Assurance level for attestation requirements."
                  },
                  "bindingType": {
                    "type": "string",
                    "enum": [
                      "claim",
                      "key",
                      "biometric",
                      "none"
                    ],
                    "description": "Subject binding type."
                  },
                  "schemaURIs": {
                    "description": "Optional schema URI entries.",
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "credentialConfigId": {
                          "description": "Optional credential configuration id this schema URI applies to.",
                          "type": "string"
                        },
                        "format": {
                          "description": "Optional credential format for this schema URI.",
                          "type": "string"
                        },
                        "uri": {
                          "description": "Schema URI reference.",
                          "type": "string"
                        },
                        "meta": {
                          "description": "Optional metadata attached to the schema URI.",
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "trustedAuthorities": {
                    "description": "Optional trusted authority entries.",
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "trustListId": {
                          "description": "Optional trust list id.",
                          "type": "string"
                        },
                        "frameworkType": {
                          "description": "Trust framework type.",
                          "type": "string",
                          "enum": [
                            "aki",
                            "etsi_tl",
                            "openid_federation"
                          ]
                        },
                        "value": {
                          "description": "Framework-specific authority value.",
                          "type": "string"
                        },
                        "verificationMethod": {
                          "description": "Verification method descriptor.",
                          "anyOf": [
                            {
                              "type": "object",
                              "propertyNames": {
                                "type": "string"
                              },
                              "additionalProperties": {}
                            },
                            {
                              "type": "string"
                            }
                          ]
                        }
                      },
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "version",
                  "attestationLoS",
                  "bindingType"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "embeddedDisclosurePolicy": {
            "description": "Optional embedded disclosure policy.",
            "anyOf": [
              {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "policy": {
                        "type": "string",
                        "const": "attestationBased",
                        "description": "Attestation-based policy discriminator."
                      },
                      "values": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "claims": {
                              "description": "Claims constraints considered by policy evaluation.",
                              "type": "array",
                              "items": {}
                            },
                            "credentials": {
                              "type": "array",
                              "items": {},
                              "description": "Credential constraints considered by policy evaluation."
                            },
                            "credential_sets": {
                              "description": "Optional credential set constraints.",
                              "type": "array",
                              "items": {}
                            }
                          },
                          "required": [
                            "credentials"
                          ],
                          "additionalProperties": false
                        },
                        "description": "Attestation requirements used for policy enforcement."
                      }
                    },
                    "required": [
                      "policy",
                      "values"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "policy": {
                        "type": "string",
                        "const": "none",
                        "description": "No disclosure policy enforcement."
                      }
                    },
                    "required": [
                      "policy"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "policy": {
                        "type": "string",
                        "const": "allowList",
                        "description": "Allow-list based policy discriminator."
                      },
                      "values": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        },
                        "description": "Allowed values for policy checks."
                      }
                    },
                    "required": [
                      "policy",
                      "values"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "policy": {
                        "type": "string",
                        "const": "rootOfTrust",
                        "description": "Root-of-trust policy discriminator."
                      },
                      "values": {
                        "type": "string",
                        "description": "Root-of-trust identifier or reference."
                      }
                    },
                    "required": [
                      "policy",
                      "values"
                    ],
                    "additionalProperties": false
                  }
                ],
                "description": "Embedded disclosure policy configuration."
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "config",
          "fields"
        ],
        "additionalProperties": false,
        "description": "Payload for creating credential issuance configuration.",
        "$defs": {
          "__schema0": {
            "type": "object",
            "properties": {
              "path": {
                "type": "array",
                "items": {
                  "type": [
                    "string",
                    "number",
                    "null"
                  ]
                },
                "description": "Path to this claim inside the credential payload."
              },
              "type": {
                "type": "string",
                "enum": [
                  "string",
                  "number",
                  "integer",
                  "boolean",
                  "object",
                  "array"
                ],
                "description": "Data type of the claim value."
              },
              "defaultValue": {
                "description": "Optional default value for this field."
              },
              "mandatory": {
                "description": "Whether the field is required at issuance time.",
                "type": "boolean"
              },
              "disclosable": {
                "description": "Whether the claim is selectively disclosable.",
                "type": "boolean"
              },
              "namespace": {
                "description": "Optional namespace for claim grouping.",
                "type": "string"
              },
              "display": {
                "description": "Localized display metadata for this field.",
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "locale": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Locale tag for the display entry."
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Human-readable field name."
                    },
                    "description": {
                      "description": "Optional field description for this locale.",
                      "type": "string"
                    }
                  },
                  "required": [
                    "locale",
                    "name"
                  ],
                  "additionalProperties": false
                }
              },
              "constraints": {
                "description": "Optional validation constraints for the claim value.",
                "type": "object",
                "propertyNames": {
                  "type": "string"
                },
                "additionalProperties": {}
              },
              "children": {
                "description": "Nested child claim definitions for object or array fields.",
                "type": "array",
                "items": {
                  "$ref": "#/$defs/CredentialConfigCreate/$defs/__schema0"
                }
              }
            },
            "required": [
              "path",
              "type"
            ],
            "additionalProperties": false
          }
        },
        "title": "CredentialConfigCreate"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/IssuanceConfigFile.schema.json",
    "title": "IssuanceConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/IssuanceConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "$ref": "#/$defs/IssuanceConfig"
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "IssuanceConfig": {
        "type": "object",
        "properties": {
          "batchSize": {
            "description": "Optional issuance batch size.",
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "dPopRequired": {
            "description": "Require DPoP proofs for issuance endpoints.",
            "type": "boolean"
          },
          "walletAttestationRequired": {
            "description": "Default wallet attestation requirement for managed authorization servers.",
            "type": "boolean"
          },
          "walletProviderTrustLists": {
            "description": "Shared wallet provider trust lists for key attestations and default authorization server wallet authentication.",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "trustListId": {
                  "type": "string",
                  "minLength": 1
                },
                "url": {
                  "description": "URL of the wallet provider trust list.",
                  "type": "string",
                  "format": "uri"
                },
                "verifierKey": {
                  "description": "Optional verifier key material used for trust list verification.",
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                },
                "verifierX509Der": {
                  "description": "Optional verifier certificate in DER/base64 form.",
                  "type": "string"
                }
              },
              "additionalProperties": false
            }
          },
          "signingKeyId": {
            "description": "Default signing key chain id for credential issuance.",
            "type": "string",
            "minLength": 1
          },
          "authorizationServers": {
            "minItems": 1,
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "external",
                      "description": "Use an externally managed authorization server."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "issuer": {
                      "type": "string",
                      "format": "uri",
                      "description": "Issuer URL for the external authorization server."
                    },
                    "sessionBinding": {
                      "description": "Explicit mapping from an external access-token claim to an existing issuance session.",
                      "type": "object",
                      "properties": {
                        "method": {
                          "type": "string",
                          "const": "access_token_claim",
                          "description": "Read the correlation value from a configured access-token claim."
                        },
                        "claim": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Claim name that contains the issuance-session correlation value."
                        }
                      },
                      "required": [
                        "method",
                        "claim"
                      ],
                      "additionalProperties": false
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id",
                    "issuer"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "oid4vp",
                      "description": "Use OID4VP-based authorization server chaining."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "presentationConfigId": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Presentation configuration id used during authorization."
                    },
                    "immediateWalletRedirect": {
                      "description": "Redirect wallets immediately after authorization response creation.",
                      "type": "boolean"
                    },
                    "token": {
                      "description": "Optional token issuance settings.",
                      "type": "object",
                      "properties": {
                        "lifetimeSeconds": {
                          "description": "Access token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        },
                        "signingKeyId": {
                          "description": "Optional key chain id used to sign issued tokens.",
                          "type": "string",
                          "minLength": 1
                        },
                        "refreshTokenEnabled": {
                          "description": "Enable issuing refresh tokens.",
                          "type": "boolean"
                        },
                        "refreshTokenExpiresInSeconds": {
                          "description": "Refresh token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        }
                      },
                      "additionalProperties": false
                    },
                    "requireDPoP": {
                      "description": "Require DPoP proofs for token/credential requests.",
                      "type": "boolean"
                    },
                    "walletAttestationRequired": {
                      "description": "Require wallet attestation for this authorization server.",
                      "type": "boolean"
                    },
                    "walletProviderTrustLists": {
                      "description": "Optional wallet provider trust list references for this authorization server.",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "trustListId": {
                            "type": "string",
                            "minLength": 1
                          },
                          "url": {
                            "description": "URL of the wallet provider trust list.",
                            "type": "string",
                            "format": "uri"
                          },
                          "verifierKey": {
                            "description": "Optional verifier key material used for trust list verification.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "verifierX509Der": {
                            "description": "Optional verifier certificate in DER/base64 form.",
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id",
                    "presentationConfigId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "chained",
                      "description": "Use upstream OIDC as authorization source."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "upstream": {
                      "type": "object",
                      "properties": {
                        "issuer": {
                          "type": "string",
                          "format": "uri",
                          "description": "Upstream OIDC issuer URL."
                        },
                        "clientId": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Client id for upstream OIDC authentication."
                        },
                        "clientSecret": {
                          "description": "Optional client secret for upstream OIDC authentication.",
                          "type": "string",
                          "minLength": 1
                        },
                        "scopes": {
                          "description": "Optional scopes requested from the upstream issuer.",
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "required": [
                        "issuer",
                        "clientId"
                      ],
                      "additionalProperties": false,
                      "description": "Upstream OIDC connection settings."
                    },
                    "token": {
                      "description": "Optional token issuance settings.",
                      "type": "object",
                      "properties": {
                        "lifetimeSeconds": {
                          "description": "Access token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        },
                        "signingKeyId": {
                          "description": "Optional key chain id used to sign issued tokens.",
                          "type": "string",
                          "minLength": 1
                        },
                        "refreshTokenEnabled": {
                          "description": "Enable issuing refresh tokens.",
                          "type": "boolean"
                        },
                        "refreshTokenExpiresInSeconds": {
                          "description": "Refresh token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        }
                      },
                      "additionalProperties": false
                    },
                    "requireDPoP": {
                      "description": "Require DPoP proofs for token/credential requests.",
                      "type": "boolean"
                    },
                    "walletAttestationRequired": {
                      "description": "Require wallet attestation for this authorization server.",
                      "type": "boolean"
                    },
                    "walletProviderTrustLists": {
                      "description": "Optional wallet provider trust list references for this authorization server.",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "trustListId": {
                            "type": "string",
                            "minLength": 1
                          },
                          "url": {
                            "description": "URL of the wallet provider trust list.",
                            "type": "string",
                            "format": "uri"
                          },
                          "verifierKey": {
                            "description": "Optional verifier key material used for trust list verification.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "verifierX509Der": {
                            "description": "Optional verifier certificate in DER/base64 form.",
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id",
                    "upstream"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "built-in",
                      "description": "Use EUDIPLO built-in authorization server."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "token": {
                      "description": "Optional token issuance settings.",
                      "type": "object",
                      "properties": {
                        "lifetimeSeconds": {
                          "description": "Access token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        },
                        "signingKeyId": {
                          "description": "Optional key chain id used to sign issued tokens.",
                          "type": "string",
                          "minLength": 1
                        },
                        "refreshTokenEnabled": {
                          "description": "Enable issuing refresh tokens.",
                          "type": "boolean"
                        },
                        "refreshTokenExpiresInSeconds": {
                          "description": "Refresh token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        }
                      },
                      "additionalProperties": false
                    },
                    "requireDPoP": {
                      "description": "Require DPoP proofs for token/credential requests.",
                      "type": "boolean"
                    },
                    "walletAttestationRequired": {
                      "description": "Require wallet attestation for this authorization server.",
                      "type": "boolean"
                    },
                    "walletProviderTrustLists": {
                      "description": "Optional wallet provider trust list references for this authorization server.",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "trustListId": {
                            "type": "string",
                            "minLength": 1
                          },
                          "url": {
                            "description": "URL of the wallet provider trust list.",
                            "type": "string",
                            "format": "uri"
                          },
                          "verifierKey": {
                            "description": "Optional verifier key material used for trust list verification.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "verifierX509Der": {
                            "description": "Optional verifier certificate in DER/base64 form.",
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id"
                  ],
                  "additionalProperties": false
                }
              ],
              "description": "Supported authorization server configurations."
            },
            "description": "Configured authorization server entries."
          },
          "federation": {
            "description": "Optional OpenID Federation settings.",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "role": {
                    "description": "Federation role for this issuer.",
                    "type": "string",
                    "enum": [
                      "trust_anchor",
                      "intermediate",
                      "leaf"
                    ]
                  },
                  "mode": {
                    "description": "Federation operation mode.",
                    "type": "string",
                    "enum": [
                      "federation-only",
                      "hybrid"
                    ]
                  },
                  "entityId": {
                    "description": "Optional local federation entity id.",
                    "type": "string"
                  },
                  "enforceSigningPolicy": {
                    "description": "Enforce strict signing policy checks.",
                    "type": "boolean"
                  },
                  "cacheTtlSeconds": {
                    "description": "Cache time-to-live for federation metadata in seconds.",
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "trustAnchors": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "entityId": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Federation trust anchor entity id."
                        },
                        "entityConfigurationUri": {
                          "type": "string",
                          "format": "uri",
                          "description": "Entity configuration URI for the trust anchor."
                        }
                      },
                      "required": [
                        "entityId",
                        "entityConfigurationUri"
                      ],
                      "additionalProperties": false
                    },
                    "description": "Federation trust anchors."
                  }
                },
                "required": [
                  "trustAnchors"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "registrationCertificate": {
            "description": "Optional registration certificate settings.",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "enabled": {
                    "description": "Enable issuer registration certificate support.",
                    "type": "boolean"
                  },
                  "mode": {
                    "description": "How registration certificate data is provided.",
                    "type": "string",
                    "enum": [
                      "import",
                      "generate"
                    ]
                  },
                  "jwt": {
                    "description": "Optional registration certificate JWT when using import mode.",
                    "type": "string"
                  },
                  "privacyPolicy": {
                    "description": "Optional privacy policy URI.",
                    "type": "string"
                  },
                  "supportUri": {
                    "description": "Optional support URI.",
                    "type": "string"
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "display": {
            "description": "Localized issuer metadata shown to wallets.",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "description": "Issuer display name.",
                  "type": "string"
                },
                "locale": {
                  "description": "Locale tag for this display entry.",
                  "type": "string"
                },
                "logo": {
                  "description": "Optional issuer logo metadata.",
                  "type": "object",
                  "properties": {
                    "uri": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Logo URI."
                    },
                    "alt_text": {
                      "description": "Optional localized alternative text.",
                      "type": "string"
                    }
                  },
                  "required": [
                    "uri"
                  ],
                  "additionalProperties": {}
                }
              },
              "additionalProperties": {}
            }
          },
          "notificationEndpointEnabled": {
            "description": "Whether the OID4VCI notification endpoint is exposed for this issuance configuration.",
            "type": "boolean"
          },
          "credentialResponseEncryption": {
            "description": "Enable encrypted credential responses.",
            "type": "boolean"
          },
          "credentialRequestEncryption": {
            "description": "Require encrypted credential requests.",
            "type": "boolean"
          },
          "txCodeMaxAttempts": {
            "description": "Maximum verification attempts for transaction codes. Null resets to defaults.",
            "anyOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "authorizationServers"
        ],
        "additionalProperties": false,
        "title": "IssuanceConfig"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/KeyChainConfigFile.schema.json",
    "title": "KeyChainConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/KeyChainConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ]
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "usageType": {
            "type": "string",
            "enum": [
              "access",
              "attestation",
              "trustList",
              "statusList",
              "encrypt"
            ]
          },
          "keySource": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "private-jwk"
                  },
                  "jwk": {
                    "type": "object",
                    "properties": {
                      "kty": {
                        "type": "string",
                        "description": "Key type (for example EC)."
                      },
                      "x": {
                        "type": "string",
                        "description": "Elliptic curve public x coordinate."
                      },
                      "y": {
                        "type": "string",
                        "description": "Elliptic curve public y coordinate."
                      },
                      "crv": {
                        "type": "string",
                        "description": "Elliptic curve name."
                      },
                      "d": {
                        "type": "string",
                        "description": "Private key value."
                      },
                      "alg": {
                        "description": "Optional algorithm hint.",
                        "type": "string"
                      },
                      "kid": {
                        "description": "Optional key identifier.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "kty",
                      "x",
                      "y",
                      "crv",
                      "d"
                    ],
                    "additionalProperties": false
                  },
                  "activeJwk": {
                    "type": "object",
                    "properties": {
                      "kty": {
                        "type": "string",
                        "description": "Key type (for example EC)."
                      },
                      "x": {
                        "type": "string",
                        "description": "Elliptic curve public x coordinate."
                      },
                      "y": {
                        "type": "string",
                        "description": "Elliptic curve public y coordinate."
                      },
                      "crv": {
                        "type": "string",
                        "description": "Elliptic curve name."
                      },
                      "d": {
                        "type": "string",
                        "description": "Private key value."
                      },
                      "alg": {
                        "description": "Optional algorithm hint.",
                        "type": "string"
                      },
                      "kid": {
                        "description": "Optional key identifier.",
                        "type": "string"
                      }
                    },
                    "required": [
                      "kty",
                      "x",
                      "y",
                      "crv",
                      "d"
                    ],
                    "additionalProperties": false
                  }
                },
                "required": [
                  "type",
                  "jwk"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "external-reference"
                  },
                  "provider": {
                    "type": "string"
                  },
                  "externalKeyId": {
                    "type": "string"
                  },
                  "publicJwk": {
                    "type": "object",
                    "properties": {
                      "kty": {
                        "type": "string"
                      },
                      "x": {
                        "type": "string"
                      },
                      "y": {
                        "type": "string"
                      },
                      "crv": {
                        "type": "string"
                      },
                      "alg": {
                        "type": "string"
                      },
                      "kid": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "kty",
                      "x",
                      "y",
                      "crv"
                    ],
                    "additionalProperties": false
                  },
                  "activeExternalKeyId": {
                    "type": "string"
                  },
                  "activePublicJwk": {
                    "type": "object",
                    "properties": {
                      "kty": {
                        "type": "string"
                      },
                      "x": {
                        "type": "string"
                      },
                      "y": {
                        "type": "string"
                      },
                      "crv": {
                        "type": "string"
                      },
                      "alg": {
                        "type": "string"
                      },
                      "kid": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "kty",
                      "x",
                      "y",
                      "crv"
                    ],
                    "additionalProperties": false
                  }
                },
                "required": [
                  "type",
                  "provider",
                  "externalKeyId",
                  "publicJwk"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "required"
                  },
                  "publicJwk": {
                    "type": "object",
                    "properties": {
                      "kty": {
                        "type": "string"
                      },
                      "x": {
                        "type": "string"
                      },
                      "y": {
                        "type": "string"
                      },
                      "crv": {
                        "type": "string"
                      },
                      "alg": {
                        "type": "string"
                      },
                      "kid": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "kty",
                      "x",
                      "y",
                      "crv"
                    ],
                    "additionalProperties": false
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "regenerate"
                  },
                  "keyChainType": {
                    "type": "string",
                    "enum": [
                      "standalone",
                      "internalChain"
                    ]
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              }
            ]
          },
          "crt": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "activeCertificate": {
            "description": "Active certificate for an internal key chain.",
            "type": "string"
          },
          "kmsProvider": {
            "type": "string"
          },
          "rotationPolicy": {
            "type": "object",
            "properties": {
              "enabled": {
                "type": "boolean"
              },
              "intervalDays": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 1,
                    "maximum": 3650
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "certValidityDays": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 1,
                    "maximum": 3650
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "enabled"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "usageType",
          "keySource"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "$schema",
      "metadata",
      "spec"
    ],
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/KmsConfigFile.schema.json",
    "title": "KmsConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/KmsConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "$ref": "#/$defs/KmsConfigDto"
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "KmsConfigDto": {
        "type": "object",
        "properties": {
          "defaultProvider": {
            "description": "ID of the default KMS provider. Defaults to \"db\" if not set.",
            "examples": [
              "main-vault"
            ],
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "string",
                "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
              }
            ]
          },
          "providers": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Unique identifier for this provider instance. Used when generating keys to specify which provider to use.",
                      "examples": [
                        "main-vault"
                      ]
                    },
                    "type": {
                      "type": "string",
                      "const": "db",
                      "description": "Type of the KMS provider.",
                      "examples": [
                        "db"
                      ]
                    },
                    "description": {
                      "description": "Human-readable description of this provider instance.",
                      "examples": [
                        "Production HashiCorp Vault for signing keys"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "type"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Unique identifier for this provider instance. Used when generating keys to specify which provider to use.",
                      "examples": [
                        "main-vault"
                      ]
                    },
                    "type": {
                      "type": "string",
                      "const": "vault",
                      "description": "Type of the KMS provider.",
                      "examples": [
                        "vault"
                      ]
                    },
                    "description": {
                      "description": "Human-readable description of this provider instance.",
                      "examples": [
                        "Production HashiCorp Vault for signing keys"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "vaultUrl": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "uri"
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "URL of the HashiCorp Vault instance. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${VAULT_URL}"
                      ]
                    },
                    "vaultToken": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Authentication token for HashiCorp Vault. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${VAULT_TOKEN}"
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "type",
                    "vaultUrl",
                    "vaultToken"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Unique identifier for this provider instance. Used when generating keys to specify which provider to use.",
                      "examples": [
                        "main-vault"
                      ]
                    },
                    "type": {
                      "type": "string",
                      "const": "aws-kms",
                      "description": "Type of the KMS provider.",
                      "examples": [
                        "aws-kms"
                      ]
                    },
                    "description": {
                      "description": "Human-readable description of this provider instance.",
                      "examples": [
                        "Production HashiCorp Vault for signing keys"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "region": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "AWS region for KMS. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${AWS_REGION}"
                      ]
                    },
                    "accessKeyId": {
                      "description": "AWS access key ID. Optional — uses SDK credential chain if not provided. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${AWS_ACCESS_KEY_ID}"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "secretAccessKey": {
                      "description": "AWS secret access key. Optional — uses SDK credential chain if not provided. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${AWS_SECRET_ACCESS_KEY}"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "type",
                    "region"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Unique identifier for this provider instance. Used when generating keys to specify which provider to use.",
                      "examples": [
                        "main-vault"
                      ]
                    },
                    "type": {
                      "type": "string",
                      "const": "pkcs11",
                      "description": "Type of the KMS provider.",
                      "examples": [
                        "pkcs11"
                      ]
                    },
                    "description": {
                      "description": "Human-readable description of this provider instance.",
                      "examples": [
                        "Production HashiCorp Vault for signing keys"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "library": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Absolute path to the PKCS#11 module library (.so/.dll/.dylib). Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${PKCS11_LIBRARY}"
                      ]
                    },
                    "slot": {
                      "description": "Slot selection. Either the numeric slot index (as a string for ENV interpolation, or a number) or the token label. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${PKCS11_SLOT}"
                      ],
                      "type": [
                        "number",
                        "string"
                      ]
                    },
                    "pin": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "User PIN used for C_Login. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${PKCS11_PIN}"
                      ]
                    },
                    "readOnly": {
                      "description": "Open the PKCS#11 session in read-only mode. Defaults to false.",
                      "examples": [
                        false
                      ],
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "id",
                    "type",
                    "library",
                    "slot",
                    "pin"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Unique identifier for this provider instance. Used when generating keys to specify which provider to use.",
                      "examples": [
                        "main-vault"
                      ]
                    },
                    "type": {
                      "type": "string",
                      "const": "http",
                      "description": "Type of the KMS provider.",
                      "examples": [
                        "http"
                      ]
                    },
                    "description": {
                      "description": "Human-readable description of this provider instance.",
                      "examples": [
                        "Production HashiCorp Vault for signing keys"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "baseUrl": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "uri"
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Base URL of the remote KMS microservice (no trailing slash). Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${KMS_SERVICE_URL}"
                      ]
                    },
                    "auth": {
                      "description": "Authentication method for the remote KMS service. Supports bearer token, OAuth 2.0 client credentials, and mutual TLS. Omit (or set type to \"none\") for unauthenticated services.",
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "const": "none",
                              "description": "No authentication — suitable for services on a trusted private network.",
                              "examples": [
                                "none"
                              ]
                            }
                          },
                          "required": [
                            "type"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "const": "bearer",
                              "description": "Static Bearer token sent as Authorization: Bearer <token>.",
                              "examples": [
                                "bearer"
                              ]
                            },
                            "token": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ],
                              "description": "Bearer token value. Supports ${ENV_VAR} placeholders.",
                              "examples": [
                                "${KMS_API_KEY}"
                              ]
                            }
                          },
                          "required": [
                            "type",
                            "token"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "const": "oauth2-client-credentials",
                              "description": "OAuth 2.0 Client Credentials — EUDIPLO fetches and caches short-lived tokens.",
                              "examples": [
                                "oauth2-client-credentials"
                              ]
                            },
                            "tokenUrl": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "format": "uri"
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ],
                              "description": "Token endpoint URL (e.g. Keycloak, Entra ID). Supports ${ENV_VAR} placeholders.",
                              "examples": [
                                "${IAM_TOKEN_URL}"
                              ]
                            },
                            "clientId": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ],
                              "description": "OAuth 2.0 client ID. Supports ${ENV_VAR} placeholders.",
                              "examples": [
                                "${KMS_CLIENT_ID}"
                              ]
                            },
                            "clientSecret": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ],
                              "description": "OAuth 2.0 client secret. Supports ${ENV_VAR} placeholders.",
                              "examples": [
                                "${KMS_CLIENT_SECRET}"
                              ]
                            },
                            "scope": {
                              "description": "Space-separated list of OAuth 2.0 scopes to request. Optional.",
                              "examples": [
                                "kms:sign kms:admin"
                              ],
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ]
                            }
                          },
                          "required": [
                            "type",
                            "tokenUrl",
                            "clientId",
                            "clientSecret"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "const": "mtls",
                              "description": "Mutual TLS — EUDIPLO presents a client certificate on every connection.",
                              "examples": [
                                "mtls"
                              ]
                            },
                            "certFile": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ],
                              "description": "Absolute path to the PEM-encoded client certificate file. Supports ${ENV_VAR} placeholders.",
                              "examples": [
                                "/etc/certs/eudiplo.crt"
                              ]
                            },
                            "keyFile": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ],
                              "description": "Absolute path to the PEM-encoded private key file for the client certificate. Supports ${ENV_VAR} placeholders.",
                              "examples": [
                                "/etc/certs/eudiplo.key"
                              ]
                            },
                            "caFile": {
                              "description": "Absolute path to the PEM-encoded CA bundle to trust for the remote server's certificate. Omit to use the system CA store.",
                              "examples": [
                                "/etc/certs/ca.crt"
                              ],
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1
                                },
                                {
                                  "type": "string",
                                  "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                                }
                              ]
                            }
                          },
                          "required": [
                            "type",
                            "certFile",
                            "keyFile"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    },
                    "keysPath": {
                      "description": "Path prefix for key endpoints on the remote service. Defaults to /keys.",
                      "examples": [
                        "/v1/keys"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "healthPath": {
                      "description": "Path for the health check endpoint on the remote service. Defaults to /health.",
                      "examples": [
                        "/health"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "canImport": {
                      "description": "Whether the remote service supports key import via POST {keysPath}/{kid}/import. Defaults to false.",
                      "examples": [
                        false
                      ],
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "id",
                    "type",
                    "baseUrl"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Unique identifier for this provider instance. Used when generating keys to specify which provider to use.",
                      "examples": [
                        "main-vault"
                      ]
                    },
                    "type": {
                      "type": "string",
                      "const": "csc",
                      "description": "Type of the KMS provider.",
                      "examples": [
                        "csc"
                      ]
                    },
                    "description": {
                      "description": "Human-readable description of this provider instance.",
                      "examples": [
                        "Production HashiCorp Vault for signing keys"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "baseUrl": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "uri"
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "Base URL of the CSC service (without trailing slash). Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${CSC_URL}"
                      ]
                    },
                    "tokenUrl": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "uri"
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "OAuth2 token endpoint URL for client-credentials flow. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${CSC_TOKEN_URL}"
                      ]
                    },
                    "clientId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "OAuth2 client ID. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${CSC_CLIENT_ID}"
                      ]
                    },
                    "clientSecret": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ],
                      "description": "OAuth2 client secret. Supports ${ENV_VAR} placeholders.",
                      "examples": [
                        "${CSC_CLIENT_SECRET}"
                      ]
                    },
                    "scope": {
                      "description": "OAuth2 scope to request during token acquisition.",
                      "examples": [
                        "service"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "credentialId": {
                      "description": "Default CSC credential ID. If omitted, the adapter calls credentials/list and picks the first entry.",
                      "examples": [
                        "[INTESIQCSEALEC]_SEAL_351_SIGN_1781018892758"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "userId": {
                      "description": "Optional CSC user ID used in credentials/list requests.",
                      "examples": [
                        "eudiplo_user"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "apiPath": {
                      "description": "CSC API path prefix appended to baseUrl. Defaults to /csc/v2.",
                      "examples": [
                        "/csc/v2"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "hashAlgorithmOid": {
                      "description": "Hash algorithm OID for signatures/signHash and credentials/authorize. Defaults to SHA-256 OID.",
                      "examples": [
                        "2.16.840.1.101.3.4.2.1"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "signAlgorithmOid": {
                      "description": "Signature algorithm OID for signatures/signHash. Defaults to ecdsa-with-SHA256 OID.",
                      "examples": [
                        "1.2.840.10045.4.3.2"
                      ],
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "sad": {
                      "description": "Static SAD token. If set, the adapter sends it directly in signatures/signHash requests.",
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "string",
                          "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                        }
                      ]
                    },
                    "useAuthorizeEndpoint": {
                      "description": "When true and no static SAD is provided, the adapter calls credentials/authorize to obtain SAD before signatures/signHash.",
                      "examples": [
                        false
                      ],
                      "type": "boolean"
                    },
                    "authorizeAuthData": {
                      "description": "Optional authData array passed to credentials/authorize (e.g., PIN/OTP factors).",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "anyOf": [
                              {
                                "type": "string",
                                "minLength": 1
                              },
                              {
                                "type": "string",
                                "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                              }
                            ],
                            "description": "Authentication factor identifier expected by the CSC provider (e.g., PIN, OTP).",
                            "examples": [
                              "PIN"
                            ]
                          },
                          "value": {
                            "anyOf": [
                              {
                                "type": "string",
                                "minLength": 1
                              },
                              {
                                "type": "string",
                                "pattern": "^\\$\\{([A-Z0-9_]+)\\}$"
                              }
                            ],
                            "description": "Authentication factor value sent to CSC credentials/authorize.",
                            "examples": [
                              "123456"
                            ]
                          }
                        },
                        "required": [
                          "id",
                          "value"
                        ],
                        "additionalProperties": false
                      }
                    }
                  },
                  "required": [
                    "id",
                    "type",
                    "baseUrl",
                    "tokenUrl",
                    "clientId",
                    "clientSecret"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "description": "List of KMS provider configurations. Each provider must have a unique id and a type.",
            "examples": [
              [
                {
                  "id": "db",
                  "type": "db",
                  "description": "Default database provider"
                },
                {
                  "id": "main-vault",
                  "type": "vault",
                  "description": "Production Vault",
                  "vaultUrl": "${VAULT_URL}",
                  "vaultToken": "${VAULT_TOKEN}"
                },
                {
                  "id": "aws",
                  "type": "aws-kms",
                  "description": "AWS KMS",
                  "region": "${AWS_REGION}"
                }
              ]
            ]
          }
        },
        "required": [
          "providers"
        ],
        "additionalProperties": false,
        "title": "KmsConfigDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/PresentationConfigFile.schema.json",
    "title": "PresentationConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/PresentationConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "allOf": [
          {
            "$ref": "#/$defs/PresentationConfigCreateDto"
          },
          {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        ]
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "PresentationConfigCreateDto": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "description": "Presentation configuration identifier."
          },
          "description": {
            "description": "Optional presentation configuration description.",
            "type": [
              "string",
              "null"
            ]
          },
          "lifeTime": {
            "description": "Presentation request lifetime in seconds.",
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "skewSeconds": {
            "description": "Clock skew tolerance in seconds.",
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "statusCheckMode": {
            "description": "Revocation/status check mode.",
            "type": "string",
            "enum": [
              "strict",
              "best_effort",
              "disabled"
            ]
          },
          "dcql_query": {
            "type": "object",
            "properties": {
              "credentials": {
                "minItems": 1,
                "type": "array",
                "items": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]+$",
                          "description": "Credential query identifier."
                        },
                        "multiple": {
                          "description": "Allow multiple matching credentials.",
                          "type": "boolean"
                        },
                        "claim_sets": {
                          "description": "Optional claim set constraints.",
                          "type": "array",
                          "items": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          }
                        },
                        "trusted_authorities": {
                          "description": "Optional trusted authority constraints.",
                          "type": "array",
                          "items": {
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "const": "etsi_tl",
                                    "description": "Trusted authority type discriminator for ETSI trust lists."
                                  },
                                  "values": {
                                    "type": "array",
                                    "items": {
                                      "type": "object",
                                      "properties": {
                                        "trustListId": {
                                          "description": "Optional trust list id reference.",
                                          "type": "string"
                                        },
                                        "url": {
                                          "description": "Optional trust list URL reference.",
                                          "anyOf": [
                                            {
                                              "type": "string",
                                              "format": "uri"
                                            },
                                            {
                                              "type": "string",
                                              "pattern": "^<TENANT_URL>(?:\\/.*)?$"
                                            }
                                          ]
                                        },
                                        "verifierKey": {
                                          "description": "Optional verifier key material.",
                                          "type": "object",
                                          "propertyNames": {
                                            "type": "string"
                                          },
                                          "additionalProperties": {}
                                        },
                                        "verifierX509Der": {
                                          "description": "Optional verifier certificate in DER/base64 form.",
                                          "type": "string"
                                        }
                                      },
                                      "additionalProperties": false
                                    },
                                    "description": "Trust list references for ETSI TL verification."
                                  }
                                },
                                "required": [
                                  "type",
                                  "values"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "const": "openid_federation",
                                    "description": "Trusted authority type discriminator for OpenID Federation."
                                  },
                                  "values": {
                                    "type": "array",
                                    "items": {
                                      "type": "string"
                                    },
                                    "description": "OpenID Federation authority identifiers."
                                  }
                                },
                                "required": [
                                  "type",
                                  "values"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          }
                        },
                        "format": {
                          "type": "string",
                          "const": "dc+sd-jwt",
                          "description": "Credential format discriminator."
                        },
                        "meta": {
                          "type": "object",
                          "properties": {
                            "vct_values": {
                              "minItems": 1,
                              "type": "array",
                              "items": {
                                "type": "string"
                              },
                              "description": "Accepted VCT values."
                            }
                          },
                          "required": [
                            "vct_values"
                          ],
                          "additionalProperties": false
                        },
                        "claims": {
                          "description": "Optional claim-level constraints.",
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "description": "Optional claim query id.",
                                "type": "string"
                              },
                              "path": {
                                "type": "array",
                                "items": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "description": "Path to the claim value in presented credentials."
                              },
                              "values": {
                                "description": "Optional allowed values for the claim.",
                                "type": "array",
                                "items": {
                                  "type": "string"
                                }
                              }
                            },
                            "required": [
                              "path"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "id",
                        "format",
                        "meta"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "pattern": "^[A-Za-z0-9_-]+$",
                          "description": "Credential query identifier."
                        },
                        "multiple": {
                          "description": "Allow multiple matching credentials.",
                          "type": "boolean"
                        },
                        "claim_sets": {
                          "description": "Optional claim set constraints.",
                          "type": "array",
                          "items": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          }
                        },
                        "trusted_authorities": {
                          "description": "Optional trusted authority constraints.",
                          "type": "array",
                          "items": {
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "const": "etsi_tl",
                                    "description": "Trusted authority type discriminator for ETSI trust lists."
                                  },
                                  "values": {
                                    "type": "array",
                                    "items": {
                                      "type": "object",
                                      "properties": {
                                        "trustListId": {
                                          "description": "Optional trust list id reference.",
                                          "type": "string"
                                        },
                                        "url": {
                                          "description": "Optional trust list URL reference.",
                                          "anyOf": [
                                            {
                                              "type": "string",
                                              "format": "uri"
                                            },
                                            {
                                              "type": "string",
                                              "pattern": "^<TENANT_URL>(?:\\/.*)?$"
                                            }
                                          ]
                                        },
                                        "verifierKey": {
                                          "description": "Optional verifier key material.",
                                          "type": "object",
                                          "propertyNames": {
                                            "type": "string"
                                          },
                                          "additionalProperties": {}
                                        },
                                        "verifierX509Der": {
                                          "description": "Optional verifier certificate in DER/base64 form.",
                                          "type": "string"
                                        }
                                      },
                                      "additionalProperties": false
                                    },
                                    "description": "Trust list references for ETSI TL verification."
                                  }
                                },
                                "required": [
                                  "type",
                                  "values"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "const": "openid_federation",
                                    "description": "Trusted authority type discriminator for OpenID Federation."
                                  },
                                  "values": {
                                    "type": "array",
                                    "items": {
                                      "type": "string"
                                    },
                                    "description": "OpenID Federation authority identifiers."
                                  }
                                },
                                "required": [
                                  "type",
                                  "values"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          }
                        },
                        "format": {
                          "type": "string",
                          "const": "mso_mdoc",
                          "description": "Credential format discriminator."
                        },
                        "meta": {
                          "type": "object",
                          "properties": {
                            "doctype_value": {
                              "type": "string",
                              "minLength": 1,
                              "description": "Expected mDoc doctype value."
                            }
                          },
                          "required": [
                            "doctype_value"
                          ],
                          "additionalProperties": false
                        },
                        "claims": {
                          "description": "Optional mDoc claim-level constraints.",
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "description": "Optional claim query id.",
                                "type": "string"
                              },
                              "path": {
                                "type": "array",
                                "items": {
                                  "type": [
                                    "string",
                                    "number"
                                  ]
                                },
                                "description": "Path to the claim value in presented credentials."
                              },
                              "values": {
                                "description": "Optional allowed values for the claim.",
                                "type": "array",
                                "items": {
                                  "type": "string"
                                }
                              },
                              "intent_to_retain": {
                                "description": "Whether relying party intends to retain the claim.",
                                "type": "boolean"
                              }
                            },
                            "required": [
                              "path"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "id",
                        "format",
                        "meta"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "description": "Credential queries requested by the verifier."
              },
              "credential_sets": {
                "description": "Optional higher-level credential set requirements.",
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "options": {
                      "minItems": 1,
                      "type": "array",
                      "items": {
                        "minItems": 1,
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "description": "Alternative credential query id combinations."
                    },
                    "required": {
                      "description": "Whether this credential set is mandatory.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "options"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "credentials"
            ],
            "additionalProperties": false,
            "description": "DCQL query defining requested credentials and claims."
          },
          "transaction_data": {
            "description": "Optional transaction data descriptors.",
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "description": "Transaction data type identifier."
                    },
                    "credential_ids": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      },
                      "description": "Credential query ids this transaction data applies to."
                    },
                    "payload": {
                      "description": "Transaction details. Required for TS12 SCA transaction data."
                    }
                  },
                  "required": [
                    "type",
                    "credential_ids"
                  ],
                  "additionalProperties": {}
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "registration_cert": {
            "description": "Optional registration certificate request settings.",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "body": {
                    "type": "object",
                    "properties": {
                      "privacy_policy": {
                        "type": "string"
                      },
                      "support_uri": {
                        "type": "string"
                      },
                      "intermediary": {
                        "type": "string"
                      },
                      "purpose": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "lang": {
                              "type": "string"
                            },
                            "content": {
                              "type": "string"
                            }
                          },
                          "required": [
                            "lang",
                            "content"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "credentials": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        }
                      },
                      "provided_attestations": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        }
                      }
                    },
                    "additionalProperties": false
                  },
                  "jwt": {
                    "type": "string"
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "registrationCertImportJwt": {
            "description": "Optional imported registration certificate JWT.",
            "type": [
              "string",
              "null"
            ]
          },
          "registrationCertImportId": {
            "description": "Optional registrar-side registration certificate id.",
            "type": [
              "string",
              "null"
            ]
          },
          "registrationCertBodyPrivacyPolicy": {
            "description": "Optional registration certificate privacy policy URI.",
            "type": [
              "string",
              "null"
            ]
          },
          "registrationCertBodySupportUri": {
            "description": "Optional registration certificate support URI.",
            "type": [
              "string",
              "null"
            ]
          },
          "registrationCertBodyIntermediary": {
            "description": "Optional registration certificate intermediary.",
            "type": [
              "string",
              "null"
            ]
          },
          "registrationCertBodyPurpose": {
            "description": "Optional registration certificate purpose entries.",
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "lang": {
                      "type": "string"
                    },
                    "content": {
                      "type": "string"
                    }
                  },
                  "additionalProperties": false
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "webhookEndpointId": {
            "description": "Optional webhook endpoint id for presentation callbacks.",
            "type": [
              "string",
              "null"
            ]
          },
          "attached": {
            "description": "Optional attachments included with presentation requests.",
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "format": {
                      "type": "string",
                      "description": "Attachment format identifier."
                    },
                    "data": {
                      "description": "Attachment payload."
                    },
                    "credential_ids": {
                      "description": "Optional credential query ids bound to this attachment.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  },
                  "required": [
                    "format",
                    "data"
                  ],
                  "additionalProperties": false
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "redirectUri": {
            "description": "Optional redirect URI after presentation completion.",
            "type": [
              "string",
              "null"
            ]
          },
          "accessKeyChainId": {
            "description": "Optional key chain id for access token/auth operations.",
            "type": [
              "string",
              "null"
            ]
          },
          "readerAuth": {
            "description": "Whether reader authentication is required for mDoc requests.",
            "type": [
              "boolean",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "dcql_query"
        ],
        "additionalProperties": false,
        "title": "PresentationConfigCreateDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/RegistrarConfigFile.schema.json",
    "title": "RegistrarConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/RegistrarConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "$ref": "#/$defs/CreateRegistrarConfigDto"
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "CreateRegistrarConfigDto": {
        "type": "object",
        "properties": {
          "registrarUrl": {
            "type": "string",
            "format": "uri",
            "description": "Base URL of the registrar service."
          },
          "oidcUrl": {
            "type": "string",
            "format": "uri",
            "description": "OIDC discovery or issuer URL used for authentication."
          },
          "clientId": {
            "type": "string",
            "minLength": 1,
            "description": "OAuth client ID used against the registrar."
          },
          "clientSecret": {
            "description": "Optional OAuth client secret for registrar authentication.",
            "type": "string",
            "minLength": 1
          },
          "username": {
            "type": "string",
            "minLength": 1,
            "description": "Username used for registrar authentication."
          },
          "password": {
            "type": "string",
            "minLength": 1,
            "description": "Password used for registrar authentication."
          },
          "registrationCertificateDefaults": {
            "description": "Optional default registration certificate values.",
            "anyOf": [
              {
                "type": "object",
                "propertyNames": {
                  "type": "string"
                },
                "additionalProperties": {}
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "registrarUrl",
          "oidcUrl",
          "clientId",
          "username",
          "password"
        ],
        "additionalProperties": false,
        "title": "CreateRegistrarConfigDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/StatusListConfigFile.schema.json",
    "title": "StatusListConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/StatusListConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "allOf": [
          {
            "$ref": "#/$defs/StatusListImportDto"
          },
          {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        ]
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "StatusListImportDto": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "description": "Status list identifier."
          },
          "credentialConfigurationId": {
            "description": "Optional credential configuration binding. Null means shared list.",
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          },
          "keyChainId": {
            "description": "Optional key chain used for signing this status list.",
            "type": "string",
            "minLength": 1
          },
          "capacity": {
            "description": "Optional list capacity override.",
            "type": "integer",
            "minimum": 100,
            "maximum": 9007199254740991
          },
          "bits": {
            "description": "Optional bits-per-status override.",
            "anyOf": [
              {
                "type": "number",
                "const": 1
              },
              {
                "type": "number",
                "const": 2
              },
              {
                "type": "number",
                "const": 4
              },
              {
                "type": "number",
                "const": 8
              }
            ]
          }
        },
        "required": [
          "id"
        ],
        "additionalProperties": false,
        "title": "StatusListImportDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json",
    "title": "TenantConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ]
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "type": "object",
        "properties": {
          "name": {
            "default": "EUDIPLO",
            "description": "Display name of the tenant.",
            "type": "string",
            "minLength": 1
          },
          "description": {
            "description": "Optional tenant description.",
            "type": "string",
            "minLength": 1
          },
          "sessionConfig": {
            "description": "Optional tenant-specific session storage configuration.",
            "type": "object",
            "properties": {
              "ttlSeconds": {
                "description": "Session time-to-live in seconds.",
                "type": "integer",
                "minimum": 60,
                "maximum": 9007199254740991
              },
              "cleanupMode": {
                "description": "Whether to fully delete or anonymize expired sessions.",
                "type": "string",
                "enum": [
                  "full",
                  "anonymize"
                ]
              }
            },
            "additionalProperties": false
          },
          "statusListConfig": {
            "description": "Optional tenant-specific status list defaults.",
            "type": "object",
            "properties": {
              "capacity": {
                "description": "Default status list capacity.",
                "type": "integer",
                "minimum": 100,
                "maximum": 9007199254740991
              },
              "bits": {
                "description": "Bits-per-status setting (1, 2, 4, or 8).",
                "anyOf": [
                  {
                    "type": "number",
                    "const": 1
                  },
                  {
                    "type": "number",
                    "const": 2
                  },
                  {
                    "type": "number",
                    "const": 4
                  },
                  {
                    "type": "number",
                    "const": 8
                  }
                ]
              },
              "ttl": {
                "description": "JWT TTL for status list tokens in seconds.",
                "type": "integer",
                "minimum": 60,
                "maximum": 9007199254740991
              },
              "immediateUpdate": {
                "description": "Regenerate status list JWTs immediately after status updates.",
                "type": "boolean"
              },
              "enableAggregation": {
                "description": "Include aggregation_uri in generated status list JWTs.",
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "name"
        ],
        "additionalProperties": false,
        "description": "Payload used when importing tenant metadata from config files."
      }
    },
    "required": [
      "$schema",
      "metadata",
      "spec"
    ],
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/TrustListConfigFile.schema.json",
    "title": "TrustListConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/TrustListConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "allOf": [
          {
            "$ref": "#/$defs/TrustListCreateDto"
          },
          {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        ]
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "TrustListCreateDto": {
        "type": "object",
        "properties": {
          "id": {
            "description": "Optional trust list id. If omitted, one may be generated.",
            "type": "string",
            "minLength": 1
          },
          "description": {
            "description": "Optional trust list description.",
            "type": "string"
          },
          "keyChainId": {
            "description": "Optional key chain id used to sign trust list payloads.",
            "type": "string",
            "minLength": 1
          },
          "entities": {
            "minItems": 1,
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "internal",
                      "description": "Use locally managed key chains for trust material."
                    },
                    "issuerKeyChainId": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Key chain id for issuer certificate material."
                    },
                    "revocationKeyChainId": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Key chain id for revocation/status list certificate material."
                    },
                    "providerType": {
                      "description": "Provider role; defaults to attestation-provider.",
                      "type": "string",
                      "enum": [
                        "attestation-provider",
                        "wallet-provider"
                      ]
                    },
                    "info": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Display name of the trusted entity."
                        },
                        "lang": {
                          "description": "Optional language tag for entity info.",
                          "type": "string"
                        },
                        "locale": {
                          "description": "Optional locale identifier.",
                          "type": "string"
                        },
                        "uri": {
                          "description": "Optional entity URI.",
                          "type": "string"
                        },
                        "country": {
                          "description": "Optional country name or code.",
                          "type": "string"
                        },
                        "locality": {
                          "description": "Optional locality or city.",
                          "type": "string"
                        },
                        "postalCode": {
                          "description": "Optional postal code.",
                          "type": "string"
                        },
                        "streetAddress": {
                          "description": "Optional street address.",
                          "type": "string"
                        },
                        "contactUri": {
                          "description": "Optional contact URI for the entity.",
                          "type": "string"
                        }
                      },
                      "required": [
                        "name"
                      ],
                      "additionalProperties": false,
                      "description": "Entity metadata."
                    }
                  },
                  "required": [
                    "type",
                    "issuerKeyChainId",
                    "revocationKeyChainId",
                    "info"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "external",
                      "description": "Provide external PEM certificates directly."
                    },
                    "issuerCertPem": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Issuer certificate in PEM format."
                    },
                    "revocationCertPem": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Revocation/status certificate in PEM format."
                    },
                    "providerType": {
                      "description": "Provider role; defaults to attestation-provider.",
                      "type": "string",
                      "enum": [
                        "attestation-provider",
                        "wallet-provider"
                      ]
                    },
                    "info": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Display name of the trusted entity."
                        },
                        "lang": {
                          "description": "Optional language tag for entity info.",
                          "type": "string"
                        },
                        "locale": {
                          "description": "Optional locale identifier.",
                          "type": "string"
                        },
                        "uri": {
                          "description": "Optional entity URI.",
                          "type": "string"
                        },
                        "country": {
                          "description": "Optional country name or code.",
                          "type": "string"
                        },
                        "locality": {
                          "description": "Optional locality or city.",
                          "type": "string"
                        },
                        "postalCode": {
                          "description": "Optional postal code.",
                          "type": "string"
                        },
                        "streetAddress": {
                          "description": "Optional street address.",
                          "type": "string"
                        },
                        "contactUri": {
                          "description": "Optional contact URI for the entity.",
                          "type": "string"
                        }
                      },
                      "required": [
                        "name"
                      ],
                      "additionalProperties": false,
                      "description": "Entity metadata."
                    }
                  },
                  "required": [
                    "type",
                    "issuerCertPem",
                    "revocationCertPem",
                    "info"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "description": "One or more entities included in this trust list."
          },
          "data": {
            "description": "Optional additional custom payload data.",
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          }
        },
        "required": [
          "entities"
        ],
        "additionalProperties": false,
        "title": "TrustListCreateDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v1/WebhookEndpointConfigFile.schema.json",
    "title": "WebhookEndpointConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v1/WebhookEndpointConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "allOf": [
          {
            "$ref": "#/$defs/CreateWebhookEndpointDto"
          },
          {
            "type": "object",
            "required": [
              "id"
            ],
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              }
            }
          }
        ]
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "CreateWebhookEndpointDto": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "description": "Unique webhook endpoint identifier."
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "description": "Display name of the webhook endpoint."
          },
          "description": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ],
            "description": "Optional webhook endpoint description."
          },
          "url": {
            "type": "string",
            "format": "uri",
            "description": "Destination URL for webhook delivery."
          },
          "auth": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "none",
                    "description": "Disable webhook authentication."
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false,
                "description": "No webhook authentication variant."
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "apiKey",
                    "description": "Use API key authentication for webhook requests."
                  },
                  "config": {
                    "type": "object",
                    "properties": {
                      "headerName": {
                        "type": "string",
                        "minLength": 1,
                        "description": "HTTP header name for the API key."
                      },
                      "value": {
                        "type": "string",
                        "minLength": 1,
                        "description": "API key value sent with webhook requests."
                      }
                    },
                    "required": [
                      "headerName",
                      "value"
                    ],
                    "additionalProperties": false,
                    "description": "API key webhook authentication settings."
                  }
                },
                "required": [
                  "type",
                  "config"
                ],
                "additionalProperties": false,
                "description": "API key webhook authentication variant."
              }
            ],
            "description": "Authentication configuration applied to outgoing webhook requests."
          }
        },
        "required": [
          "id",
          "name",
          "url",
          "auth"
        ],
        "additionalProperties": false,
        "title": "CreateWebhookEndpointDto"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://eudiplo.dev/schemas/v2/IssuanceConfigFile.schema.json",
    "title": "IssuanceConfigFile",
    "type": "object",
    "properties": {
      "$schema": {
        "type": "string",
        "const": "https://eudiplo.dev/schemas/v2/IssuanceConfigFile.schema.json"
      },
      "metadata": {
        "type": "object",
        "properties": {
          "generation": {
            "type": "integer",
            "minimum": 1,
            "description": "Monotonically increasing configuration generation."
          },
          "ownership": {
            "type": "string",
            "enum": [
              "unmanaged",
              "file-managed"
            ],
            "description": "Requested ownership recorded when the document is applied."
          }
        },
        "additionalProperties": false
      },
      "spec": {
        "$ref": "#/$defs/IssuanceConfig"
      }
    },
    "required": [
      "$schema",
      "spec"
    ],
    "additionalProperties": false,
    "$defs": {
      "IssuanceConfig": {
        "type": "object",
        "properties": {
          "batchSize": {
            "description": "Optional issuance batch size.",
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "dPopRequired": {
            "description": "Require DPoP proofs for issuance endpoints.",
            "type": "boolean"
          },
          "walletAttestationRequired": {
            "description": "Default wallet attestation requirement for managed authorization servers.",
            "type": "boolean"
          },
          "walletProviderTrustLists": {
            "description": "Shared wallet provider trust lists for key attestations and default authorization server wallet authentication.",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "trustListId": {
                  "type": "string",
                  "minLength": 1
                },
                "url": {
                  "description": "URL of the wallet provider trust list.",
                  "type": "string",
                  "format": "uri"
                },
                "verifierKey": {
                  "description": "Optional verifier key material used for trust list verification.",
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                },
                "verifierX509Der": {
                  "description": "Optional verifier certificate in DER/base64 form.",
                  "type": "string"
                }
              },
              "additionalProperties": false
            }
          },
          "signingKeyId": {
            "description": "Default signing key chain id for credential issuance.",
            "type": "string",
            "minLength": 1
          },
          "authorizationServers": {
            "minItems": 1,
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "external",
                      "description": "Use an externally managed authorization server."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "issuer": {
                      "type": "string",
                      "format": "uri",
                      "description": "Issuer URL for the external authorization server."
                    },
                    "sessionBinding": {
                      "description": "Explicit mapping from an external access-token claim to an existing issuance session.",
                      "type": "object",
                      "properties": {
                        "method": {
                          "type": "string",
                          "const": "access_token_claim",
                          "description": "Read the correlation value from a configured access-token claim."
                        },
                        "claim": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Claim name that contains the issuance-session correlation value."
                        }
                      },
                      "required": [
                        "method",
                        "claim"
                      ],
                      "additionalProperties": false
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id",
                    "issuer"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "oid4vp",
                      "description": "Use OID4VP-based authorization server chaining."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "presentationConfigId": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Presentation configuration id used during authorization."
                    },
                    "immediateWalletRedirect": {
                      "description": "Redirect wallets immediately after authorization response creation.",
                      "type": "boolean"
                    },
                    "token": {
                      "description": "Optional token issuance settings.",
                      "type": "object",
                      "properties": {
                        "lifetimeSeconds": {
                          "description": "Access token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        },
                        "signingKeyId": {
                          "description": "Optional key chain id used to sign issued tokens.",
                          "type": "string",
                          "minLength": 1
                        },
                        "refreshTokenEnabled": {
                          "description": "Enable issuing refresh tokens.",
                          "type": "boolean"
                        },
                        "refreshTokenExpiresInSeconds": {
                          "description": "Refresh token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        }
                      },
                      "additionalProperties": false
                    },
                    "requireDPoP": {
                      "description": "Require DPoP proofs for token/credential requests.",
                      "type": "boolean"
                    },
                    "walletAttestationRequired": {
                      "description": "Require wallet attestation for this authorization server.",
                      "type": "boolean"
                    },
                    "walletProviderTrustLists": {
                      "description": "Optional wallet provider trust list references for this authorization server.",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "trustListId": {
                            "type": "string",
                            "minLength": 1
                          },
                          "url": {
                            "description": "URL of the wallet provider trust list.",
                            "type": "string",
                            "format": "uri"
                          },
                          "verifierKey": {
                            "description": "Optional verifier key material used for trust list verification.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "verifierX509Der": {
                            "description": "Optional verifier certificate in DER/base64 form.",
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id",
                    "presentationConfigId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "chained",
                      "description": "Use upstream OIDC as authorization source."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "upstream": {
                      "type": "object",
                      "properties": {
                        "issuer": {
                          "type": "string",
                          "format": "uri",
                          "description": "Upstream OIDC issuer URL."
                        },
                        "clientId": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Client id for upstream OIDC authentication."
                        },
                        "clientSecret": {
                          "description": "Optional client secret for upstream OIDC authentication.",
                          "type": "string",
                          "minLength": 1
                        },
                        "scopes": {
                          "description": "Optional scopes requested from the upstream issuer.",
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "required": [
                        "issuer",
                        "clientId"
                      ],
                      "additionalProperties": false,
                      "description": "Upstream OIDC connection settings."
                    },
                    "token": {
                      "description": "Optional token issuance settings.",
                      "type": "object",
                      "properties": {
                        "lifetimeSeconds": {
                          "description": "Access token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        },
                        "signingKeyId": {
                          "description": "Optional key chain id used to sign issued tokens.",
                          "type": "string",
                          "minLength": 1
                        },
                        "refreshTokenEnabled": {
                          "description": "Enable issuing refresh tokens.",
                          "type": "boolean"
                        },
                        "refreshTokenExpiresInSeconds": {
                          "description": "Refresh token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        }
                      },
                      "additionalProperties": false
                    },
                    "requireDPoP": {
                      "description": "Require DPoP proofs for token/credential requests.",
                      "type": "boolean"
                    },
                    "walletAttestationRequired": {
                      "description": "Require wallet attestation for this authorization server.",
                      "type": "boolean"
                    },
                    "walletProviderTrustLists": {
                      "description": "Optional wallet provider trust list references for this authorization server.",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "trustListId": {
                            "type": "string",
                            "minLength": 1
                          },
                          "url": {
                            "description": "URL of the wallet provider trust list.",
                            "type": "string",
                            "format": "uri"
                          },
                          "verifierKey": {
                            "description": "Optional verifier key material used for trust list verification.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "verifierX509Der": {
                            "description": "Optional verifier certificate in DER/base64 form.",
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id",
                    "upstream"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "const": "built-in",
                      "description": "Use EUDIPLO built-in authorization server."
                    },
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Authorization server identifier."
                    },
                    "token": {
                      "description": "Optional token issuance settings.",
                      "type": "object",
                      "properties": {
                        "lifetimeSeconds": {
                          "description": "Access token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        },
                        "signingKeyId": {
                          "description": "Optional key chain id used to sign issued tokens.",
                          "type": "string",
                          "minLength": 1
                        },
                        "refreshTokenEnabled": {
                          "description": "Enable issuing refresh tokens.",
                          "type": "boolean"
                        },
                        "refreshTokenExpiresInSeconds": {
                          "description": "Refresh token lifetime in seconds.",
                          "type": "number",
                          "minimum": 60
                        }
                      },
                      "additionalProperties": false
                    },
                    "requireDPoP": {
                      "description": "Require DPoP proofs for token/credential requests.",
                      "type": "boolean"
                    },
                    "walletAttestationRequired": {
                      "description": "Require wallet attestation for this authorization server.",
                      "type": "boolean"
                    },
                    "walletProviderTrustLists": {
                      "description": "Optional wallet provider trust list references for this authorization server.",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "trustListId": {
                            "type": "string",
                            "minLength": 1
                          },
                          "url": {
                            "description": "URL of the wallet provider trust list.",
                            "type": "string",
                            "format": "uri"
                          },
                          "verifierKey": {
                            "description": "Optional verifier key material used for trust list verification.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "verifierX509Der": {
                            "description": "Optional verifier certificate in DER/base64 form.",
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "label": {
                      "description": "Optional display label for UI selection.",
                      "type": "string"
                    },
                    "enabled": {
                      "description": "Whether this authorization server entry is enabled.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "type",
                    "id"
                  ],
                  "additionalProperties": false
                }
              ],
              "description": "Supported authorization server configurations."
            },
            "description": "Configured authorization server entries."
          },
          "federation": {
            "description": "Optional OpenID Federation settings.",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "role": {
                    "description": "Federation role for this issuer.",
                    "type": "string",
                    "enum": [
                      "trust_anchor",
                      "intermediate",
                      "leaf"
                    ]
                  },
                  "mode": {
                    "description": "Federation operation mode.",
                    "type": "string",
                    "enum": [
                      "federation-only",
                      "hybrid"
                    ]
                  },
                  "entityId": {
                    "description": "Optional local federation entity id.",
                    "type": "string"
                  },
                  "enforceSigningPolicy": {
                    "description": "Enforce strict signing policy checks.",
                    "type": "boolean"
                  },
                  "cacheTtlSeconds": {
                    "description": "Cache time-to-live for federation metadata in seconds.",
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 9007199254740991
                  },
                  "trustAnchors": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "entityId": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Federation trust anchor entity id."
                        },
                        "entityConfigurationUri": {
                          "type": "string",
                          "format": "uri",
                          "description": "Entity configuration URI for the trust anchor."
                        }
                      },
                      "required": [
                        "entityId",
                        "entityConfigurationUri"
                      ],
                      "additionalProperties": false
                    },
                    "description": "Federation trust anchors."
                  }
                },
                "required": [
                  "trustAnchors"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "registrationCertificate": {
            "description": "Optional registration certificate settings.",
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "enabled": {
                    "description": "Enable issuer registration certificate support.",
                    "type": "boolean"
                  },
                  "mode": {
                    "description": "How registration certificate data is provided.",
                    "type": "string",
                    "enum": [
                      "import",
                      "generate"
                    ]
                  },
                  "jwt": {
                    "description": "Optional registration certificate JWT when using import mode.",
                    "type": "string"
                  },
                  "privacyPolicy": {
                    "description": "Optional privacy policy URI.",
                    "type": "string"
                  },
                  "supportUri": {
                    "description": "Optional support URI.",
                    "type": "string"
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "display": {
            "description": "Localized issuer metadata shown to wallets.",
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "description": "Issuer display name.",
                  "type": "string"
                },
                "locale": {
                  "description": "Locale tag for this display entry.",
                  "type": "string"
                },
                "logo": {
                  "description": "Optional issuer logo metadata.",
                  "type": "object",
                  "properties": {
                    "uri": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Logo URI."
                    },
                    "alt_text": {
                      "description": "Optional localized alternative text.",
                      "type": "string"
                    }
                  },
                  "required": [
                    "uri"
                  ],
                  "additionalProperties": {}
                }
              },
              "additionalProperties": {}
            }
          },
          "notificationEndpointEnabled": {
            "description": "Whether the OID4VCI notification endpoint is exposed for this issuance configuration.",
            "type": "boolean"
          },
          "credentialResponseEncryption": {
            "description": "Enable encrypted credential responses.",
            "type": "boolean"
          },
          "credentialRequestEncryption": {
            "description": "Require encrypted credential requests.",
            "type": "boolean"
          },
          "txCodeMaxAttempts": {
            "description": "Maximum verification attempts for transaction codes. Null resets to defaults.",
            "anyOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "offerLifetimeSeconds": {
            "description": "Default lifetime of credential offers in seconds. Can be overridden per offer request. Null or unset: offers do not expire.",
            "anyOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "authorizationServers"
        ],
        "additionalProperties": false,
        "title": "IssuanceConfig"
      }
    }
  }
];
