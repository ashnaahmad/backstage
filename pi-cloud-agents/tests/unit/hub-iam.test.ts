/**
 * Unit tests for Cloud Hub and IAM Helper (T4.15).
 */

import { describe, expect, it } from "vitest";
import {
  generateOperatorPolicyCfnYaml,
  generateOperatorPolicyJson,
} from "../../core/iam-helper.js";

describe("T4.15 Cloud Hub and IAM Helper", () => {
  describe("IAM Operator Policy", () => {
    it("generates valid operator policy JSON with required statements", () => {
      const policyJson = generateOperatorPolicyJson();
      const parsed = JSON.parse(policyJson);

      expect(parsed.Version).toBe("2012-10-17");
      expect(parsed.Statement.length).toBeGreaterThanOrEqual(5);

      const sids = parsed.Statement.map((s: { Sid: string }) => s.Sid);
      expect(sids).toContain("CloudFormationStackOps");
      expect(sids).toContain("MicrovmManagement");
      expect(sids).toContain("PassNetworkConnector");
      expect(sids).toContain("SecretsManagerOps");
      expect(sids).toContain("S3ArtifactStorage");
    });

    it("generates standalone CloudFormation YAML template for managed policy", () => {
      const yaml = generateOperatorPolicyCfnYaml("my-custom-operator-policy");

      expect(yaml).toContain("AWSTemplateFormatVersion");
      expect(yaml).toContain("my-custom-operator-policy");
      expect(yaml).toContain("AWS::IAM::ManagedPolicy");
      expect(yaml).toContain("PassNetworkConnector");
    });
  });
});
