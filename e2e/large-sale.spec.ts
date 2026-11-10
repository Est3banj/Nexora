import { expect, test } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";

test("large offline cart → reload → interrupted upload/finalize → one atomic sale", async ({page,context})=>{
  wipeSalesAndCatalog();
  dbOne("DELETE FROM sync_sale_operations");
  dbOne("UPDATE shifts SET status='closed'");
  dbOne("INSERT INTO shifts(id,tenant_id,client_uuid,status) SELECT gen_random_uuid(),id::uuid,gen_random_uuid(),'open' FROM organization LIMIT 1");
  // Seed via the real catalog API before first local hydration.
  await page.request.post("/api/auth/sign-in/email",{data:{email:"owner@demo.test",password:"demo12345"}});
  const org=dbOne("SELECT id FROM organization LIMIT 1");
  await page.request.post("/api/auth/organization/set-active",{data:{organizationId:org}});
  for(let i=0;i<18;i++) {
    const res=await page.request.post("/api/catalog/products",{data:{name:`Grande ${String(i).padStart(2,"0")}`,variant:{name:"Único",price:100,cost:40,code:`LARGE-${i}`,stock:10}}});
    expect(res.status()).toBe(201);
  }
  const flag="pos:e2e-large-offline";
  await context.addInitScript(f=>Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>localStorage.getItem(f)!=="1"}),flag);
  await page.goto("/");
  await page.getByTestId("tab-sale").click();
  await expect(page.getByTestId("sale-item")).toHaveCount(18);
  await expect(page.getByTestId("pending-badge")).toContainText("sinc.");
  await page.evaluate(f=>localStorage.setItem(f,"1"),flag);
  await context.setOffline(true);
  for(let i=0;i<18;i++) await page.getByTestId("sale-item").filter({hasText:`Grande ${String(i).padStart(2,"0")}`}).click();
  await page.getByTestId("checkout-open").click();
  await page.getByTestId("checkout-confirm").click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  await expect(page.getByTestId("pending-badge")).toContainText("56 pendientes");
  await context.setOffline(false); // Vite shell reachable; API sync remains offline via navigator flag
  await page.reload();
  await expect(page.getByTestId("tab-sale")).toBeVisible();
  await expect(page.getByTestId("pending-badge")).toContainText("56 pendientes");
  expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
  let interrupted=false,lost=false;
  const operations=new Set<string>();
  await context.route("**/api/sync/sales/**",async route=>{
    operations.add(new URL(route.request().url()).pathname.split("/")[4]);
    if(route.request().url().endsWith("/parts")) {
      const response=await route.fetch();
      expect(response.status()).toBe(200);
      if(!interrupted) {
        interrupted=true;
        expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
        expect(dbOne("SELECT sum(stock) FROM product_variants")).toBe("180");
        await route.abort();return;
      }
      await route.fulfill({response});return;
    }
    const response=await route.fetch();
    expect(response.status()).toBe(200);
    if(!lost) {lost=true;await route.abort();return;}
    await route.fulfill({response});
  });
  await page.evaluate(f=>{localStorage.removeItem(f);window.dispatchEvent(new Event("online"));},flag);
  await expect.poll(()=>interrupted).toBe(true);
  await page.reload(); // durable local snapshot resumes the SAME operation
  await expect.poll(()=>lost,{timeout:30000}).toBe(true);
  await expect.poll(()=>page.evaluate(async()=>{
    const {getLocalDb}=await import("/src/db/instance.ts");
    const local=await getLocalDb();
    return (await local!.db.query("SELECT id FROM sync_log WHERE status<>'synced'")).rows.length;
  }),{timeout:30000}).toBe(0);
  await expect(page.getByTestId("pending-badge")).toContainText("sinc.",{timeout:30000});
  expect(lost).toBe(true);
  expect(operations.size).toBe(1);
  expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");
  expect(dbOne("SELECT count(*) FROM ticket_lines")).toBe("18");
  expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
  expect(dbOne("SELECT count(*) FROM stockdiary WHERE reason='sale'")).toBe("18");
  expect(dbOne("SELECT sum(stock) FROM product_variants")).toBe("162");
  expect(dbOne("SELECT sum(stock) FROM stockcurrent")).toBe("162");
  expect(dbOne("SELECT sum(delta) FROM stockdiary")).toBe("162");
  expect(dbOne("SELECT sum(amount) FROM payments")).toBe("1800");
  expect(dbOne("SELECT count(*) FROM product_variants WHERE cost=40 AND code LIKE 'LARGE-%'")).toBe("18");
});
