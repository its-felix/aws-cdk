import { Construct } from 'constructs';
import { StreamEventSource, BaseStreamEventSourceProps } from './stream';
import { ISecurityGroup, IVpc, SubnetSelection } from '../../aws-ec2';
import * as iam from '../../aws-iam';
import { IKey } from '../../aws-kms';
import * as lambda from '../../aws-lambda';
import { ISchemaRegistry } from '../../aws-lambda/lib/schema-registry';
import * as secretsmanager from '../../aws-secretsmanager';
import { Stack, Names, Annotations, UnscopedValidationError, ValidationError } from '../../core';
import { md5hash } from '../../core/lib/helpers-internal';

/**
 * Properties for a Kafka event source
 */
export interface KafkaEventSourceProps extends BaseStreamEventSourceProps {
  /**
   * The Kafka topic to subscribe to
   */
  readonly topic: string;
  /**
   * The secret with the Kafka credentials, see https://docs.aws.amazon.com/msk/latest/developerguide/msk-password.html for details
   * This field is required if your Kafka brokers are accessed over the Internet
   *
   * @default none
   */
  readonly secret?: secretsmanager.ISecret;
  /**
   * The identifier for the Kafka consumer group to join. The consumer group ID must be unique among all your Kafka event sources. After creating a Kafka event source mapping with the consumer group ID specified, you cannot update this value.  The value must have a length between 1 and 200 and full the pattern '[a-zA-Z0-9-\/*:_+=.@-]*'.
   * @see https://docs.aws.amazon.com/lambda/latest/dg/with-msk.html#services-msk-consumer-group-id
   *
   * @default - none
   */
  readonly consumerGroupId?: string;

  /**
   * Add filter criteria to Event Source
   * @see https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
   *
   * @default - none
   */
  readonly filters?: Array<{[key: string]: any}>;

  /**
   * Add Customer managed KMS key to encrypt Filter Criteria.
   * @see https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
   * By default, Lambda will encrypt Filter Criteria using AWS managed keys
   * @see https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#aws-managed-cmk
   *
   * @default - none
   */
  readonly filterEncryption?: IKey;

  /**
   * Add an on Failure Destination for this Kafka event. SNS/SQS/S3 are supported
   *
   * @default - discarded records are ignored
   */
  readonly onFailure?: lambda.IEventSourceDlq;

  /**
   * The time from which to start reading, in Unix time seconds.
   *
   * @default - no timestamp
   */
  readonly startingPositionTimestamp?: number;

  /**
   * Specific configuration settings for a Kafka schema registry.
   *
   * @default - none
   */
  readonly schemaRegistryConfig?: ISchemaRegistry;
}

/**
 * Properties for a MSK event source
 */
export interface ManagedKafkaEventSourceProps extends KafkaEventSourceProps {
  /**
   * An MSK cluster construct
   */
  readonly clusterArn: string;
}

/**
 * The authentication method to use with SelfManagedKafkaEventSource
 */
export enum AuthenticationMethod {
  /**
   * SASL_SCRAM_512_AUTH authentication method for your Kafka cluster
   */
  SASL_SCRAM_512_AUTH = 'SASL_SCRAM_512_AUTH',
  /**
   * SASL_SCRAM_256_AUTH authentication method for your Kafka cluster
   */
  SASL_SCRAM_256_AUTH = 'SASL_SCRAM_256_AUTH',
  /**
   * BASIC_AUTH (SASL/PLAIN) authentication method for your Kafka cluster
   */
  BASIC_AUTH = 'BASIC_AUTH',
  /**
   * CLIENT_CERTIFICATE_TLS_AUTH (mTLS) authentication method for your Kafka cluster
   */
  CLIENT_CERTIFICATE_TLS_AUTH = 'CLIENT_CERTIFICATE_TLS_AUTH',
}

/**
 * Properties for a self managed Kafka cluster event source.
 * If your Kafka cluster is only reachable via VPC make sure to configure it.
 */
export interface SelfManagedKafkaEventSourceProps extends KafkaEventSourceProps {
  /**
   * The list of host and port pairs that are the addresses of the Kafka brokers in a "bootstrap" Kafka cluster that
   * a Kafka client connects to initially to bootstrap itself. They are in the format `abc.xyz.com:xxxx`.
   */
  readonly bootstrapServers: string[];

  /**
   * If your Kafka brokers are only reachable via VPC provide the VPC here
   *
   * @default none
   */
  readonly vpc?: IVpc;

  /**
   * If your Kafka brokers are only reachable via VPC, provide the subnets selection here
   *
   * @default - none, required if setting vpc
   */
  readonly vpcSubnets?: SubnetSelection;

  /**
   * If your Kafka brokers are only reachable via VPC, provide the security group here
   *
   * @default - none, required if setting vpc
   */
  readonly securityGroup?: ISecurityGroup;

  /**
   * The authentication method for your Kafka cluster
   *
   * @default AuthenticationMethod.SASL_SCRAM_512_AUTH
   */
  readonly authenticationMethod?: AuthenticationMethod;

  /**
   * The secret with the root CA certificate used by your Kafka brokers for TLS encryption
   * This field is required if your Kafka brokers use certificates signed by a private CA
   *
   * @default - none
   */
  readonly rootCACertificate?: secretsmanager.ISecret;
}

/**
 * Use a MSK cluster as a streaming source for AWS Lambda
 */
export class ManagedKafkaEventSource extends StreamEventSource {
  // This is to work around JSII inheritance problems
  private innerProps: ManagedKafkaEventSourceProps;
  private _eventSourceMappingId?: string = undefined;
  private _eventSourceMappingArn?: string = undefined;

  constructor(props: ManagedKafkaEventSourceProps) {
    super(props);
    this.innerProps = props;
  }

  public bind(target: lambda.IFunction) {
    if (this.innerProps.startingPosition === lambda.StartingPosition.AT_TIMESTAMP && !this.innerProps.startingPositionTimestamp) {
      Annotations.of(target).addWarningV2('@aws-cdk/aws-lambda-event-source:needStartingPositionTimestamp', 'startingPositionTimestamp must be provided when startingPosition is AT_TIMESTAMP');
    }

    if (this.innerProps.startingPosition !== lambda.StartingPosition.AT_TIMESTAMP && this.innerProps.startingPositionTimestamp) {
      Annotations.of(target).addWarningV2('@aws-cdk/aws-lambda-event-source:invalidStartingPosition', 'startingPositionTimestamp can only be used when startingPosition is AT_TIMESTAMP');
    }

    const eventSourceMapping = target.addEventSourceMapping(
      `KafkaEventSource:${Names.nodeUniqueId(target.node)}${this.innerProps.topic}`,
      this.enrichMappingOptions({
        eventSourceArn: this.innerProps.clusterArn,
        filters: this.innerProps.filters,
        filterEncryption: this.innerProps.filterEncryption,
        startingPosition: this.innerProps.startingPosition,
        startingPositionTimestamp: this.innerProps.startingPositionTimestamp,
        sourceAccessConfigurations: this.sourceAccessConfigurations(),
        kafkaTopic: this.innerProps.topic,
        kafkaConsumerGroupId: this.innerProps.consumerGroupId,
        onFailure: this.innerProps.onFailure,
        supportS3OnFailureDestination: true,
        provisionedPollerConfig: this.innerProps.provisionedPollerConfig,
        schemaRegistryConfig: this.innerProps.schemaRegistryConfig,
      }),
    );

    this._eventSourceMappingId = eventSourceMapping.eventSourceMappingId;
    this._eventSourceMappingArn = eventSourceMapping.eventSourceMappingArn;

    if (this.innerProps.secret !== undefined) {
      this.innerProps.secret.grantRead(target);
    }

    target.addToRolePolicy(new iam.PolicyStatement(
      {
        actions: ['kafka:DescribeCluster', 'kafka:GetBootstrapBrokers', 'kafka:ListScramSecrets'],
        resources: [this.innerProps.clusterArn],
      },
    ));

    target.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaMSKExecutionRole'));
  }

  private sourceAccessConfigurations() {
    const sourceAccessConfigurations = [];
    if (this.innerProps.secret !== undefined) {
      // "Amazon MSK only supports SCRAM-SHA-512 authentication." from https://docs.aws.amazon.com/msk/latest/developerguide/msk-password.html#msk-password-limitations
      sourceAccessConfigurations.push({
        type: lambda.SourceAccessConfigurationType.SASL_SCRAM_512_AUTH,
        uri: this.innerProps.secret.secretArn,
      });
    }

    return sourceAccessConfigurations.length === 0
      ? undefined
      : sourceAccessConfigurations;
  }

  /**
   * The identifier for this EventSourceMapping
   */
  public get eventSourceMappingId(): string {
    if (!this._eventSourceMappingId) {
      throw new UnscopedValidationError('KafkaEventSource is not yet bound to an event source mapping');
    }
    return this._eventSourceMappingId;
  }

  /**
   * The ARN for this EventSourceMapping
   */
  public get eventSourceMappingArn(): string {
    if (!this._eventSourceMappingArn) {
      throw new UnscopedValidationError('KafkaEventSource is not yet bound to an event source mapping');
    }
    return this._eventSourceMappingArn;
  }
}

/**
 * Use a self hosted Kafka installation as a streaming source for AWS Lambda.
 */
export class SelfManagedKafkaEventSource extends StreamEventSource {
  // This is to work around JSII inheritance problems
  private innerProps: SelfManagedKafkaEventSourceProps;

  constructor(props: SelfManagedKafkaEventSourceProps) {
    super(props);
    if (props.vpc) {
      if (!props.securityGroup) {
        throw new UnscopedValidationError('securityGroup must be set when providing vpc');
      }
      if (!props.vpcSubnets) {
        throw new UnscopedValidationError('vpcSubnets must be set when providing vpc');
      }
    } else if (!props.secret) {
      throw new UnscopedValidationError('secret must be set if Kafka brokers accessed over Internet');
    }

    if (props.startingPosition === lambda.StartingPosition.AT_TIMESTAMP && !props.startingPositionTimestamp) {
      throw new UnscopedValidationError('startingPositionTimestamp must be provided when startingPosition is AT_TIMESTAMP');
    }

    if (props.startingPosition !== lambda.StartingPosition.AT_TIMESTAMP && props.startingPositionTimestamp) {
      throw new UnscopedValidationError('startingPositionTimestamp can only be used when startingPosition is AT_TIMESTAMP');
    }

    this.innerProps = props;
  }

  public bind(target: lambda.IFunction) {
    if (!(Construct.isConstruct(target))) { throw new ValidationError('Function is not a construct. Unexpected error.', target); }
    target.addEventSourceMapping(
      this.mappingId(target),
      this.enrichMappingOptions({
        filters: this.innerProps.filters,
        filterEncryption: this.innerProps.filterEncryption,
        kafkaBootstrapServers: this.innerProps.bootstrapServers,
        kafkaTopic: this.innerProps.topic,
        kafkaConsumerGroupId: this.innerProps.consumerGroupId,
        startingPosition: this.innerProps.startingPosition,
        startingPositionTimestamp: this.innerProps.startingPositionTimestamp,
        sourceAccessConfigurations: this.sourceAccessConfigurations(),
        onFailure: this.innerProps.onFailure,
        supportS3OnFailureDestination: true,
        provisionedPollerConfig: this.innerProps.provisionedPollerConfig,
        schemaRegistryConfig: this.innerProps.schemaRegistryConfig,
      }),
    );

    if (this.innerProps.secret !== undefined) {
      this.innerProps.secret.grantRead(target);
    }
  }

  private mappingId(target: lambda.IFunction) {
    const idHash = md5hash(JSON.stringify(Stack.of(target).resolve(this.innerProps.bootstrapServers)));
    return `KafkaEventSource:${idHash}:${this.innerProps.topic}`;
  }

  private sourceAccessConfigurations() {
    let authType;
    switch (this.innerProps.authenticationMethod) {
      case AuthenticationMethod.BASIC_AUTH:
        authType = lambda.SourceAccessConfigurationType.BASIC_AUTH;
        break;
      case AuthenticationMethod.CLIENT_CERTIFICATE_TLS_AUTH:
        authType = lambda.SourceAccessConfigurationType.CLIENT_CERTIFICATE_TLS_AUTH;
        break;
      case AuthenticationMethod.SASL_SCRAM_256_AUTH:
        authType = lambda.SourceAccessConfigurationType.SASL_SCRAM_256_AUTH;
        break;
      case AuthenticationMethod.SASL_SCRAM_512_AUTH:
      default:
        authType = lambda.SourceAccessConfigurationType.SASL_SCRAM_512_AUTH;
        break;
    }

    const sourceAccessConfigurations = [];
    if (this.innerProps.secret !== undefined) {
      sourceAccessConfigurations.push({ type: authType, uri: this.innerProps.secret.secretArn });
    }

    if (this.innerProps.rootCACertificate !== undefined) {
      sourceAccessConfigurations.push({
        type: lambda.SourceAccessConfigurationType.SERVER_ROOT_CA_CERTIFICATE,
        uri: this.innerProps.rootCACertificate.secretArn,
      });
    }

    if (this.innerProps.vpcSubnets !== undefined && this.innerProps.securityGroup !== undefined) {
      sourceAccessConfigurations.push({
        type: lambda.SourceAccessConfigurationType.VPC_SECURITY_GROUP,
        uri: this.innerProps.securityGroup.securityGroupId,
      },
      );
      this.innerProps.vpc?.selectSubnets(this.innerProps.vpcSubnets).subnetIds.forEach((id) => {
        sourceAccessConfigurations.push({ type: lambda.SourceAccessConfigurationType.VPC_SUBNET, uri: id });
      });
    }

    return sourceAccessConfigurations.length === 0
      ? undefined
      : sourceAccessConfigurations;
  }
}
