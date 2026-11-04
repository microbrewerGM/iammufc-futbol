import {describe,it,expect} from "vitest";
import {issuedPayload,type NotificationRow} from "../worker/src/core/question-request-notification-store";

describe("stored notification payload boundary",()=>{
  it("keeps persisted ownership, delivery and lease metadata out of the closed payload",()=>{
    const row={request_id:"a".repeat(64),inflight_revision:3,inflight_status:"released",inflight_result_path:"/es/q?metric=goals",
      account_sub:"private",issue_number:123,lease_owner:"private-service",receipt:"private"} as unknown as NotificationRow;
    expect(issuedPayload(row)).toEqual({request_id:"a".repeat(64),revision:3,status:"released",result_path:"/es/q?metric=goals"});
  });
  it.each(["inflight_revision","inflight_status"] as const)("refuses an ungranted stored payload missing %s",key=>{
    const row={request_id:"a".repeat(64),inflight_revision:1,inflight_status:"triaging",inflight_result_path:null,[key]:null} as unknown as NotificationRow;
    expect(()=>issuedPayload(row)).toThrow("notification_grant_unavailable");
  });
});
