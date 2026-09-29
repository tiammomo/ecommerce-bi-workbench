# Frontend/backend integration contract

Base `/api/v1`. All amounts are CNY decimal strings; ratios are decimal strings (0.19 = 19%), unknown values null. IDs are strings. Backend may add fields. Coordinate schema updates explicitly with frontend.

Shared filters: `start=2026-08-30&end=2026-09-28`, `channel_ids=pdd,temu`, `store_ids=...`, `sku_ids=...`, `category=...`, `search=...`, `group_by=channel|store|sku|product|listing|day`, `date_basis=paid|refund`, `page=1&page_size=50&sort_by=revenue&sort_dir=desc`. Empty lists mean all. Anomaly filter `status=negative|low_margin|missing_cost|high_refund` optional. API provides clear errors `{code,message,details?}`.

`GET /meta`: `{channels:[{id,name,color}],stores:[{id,name,channel_id,site,currency}],products:[{id,name,category}],skus:[{id,product_id,name,spec,category}],as_of,revision,timezone,dataset_version}`.

Metric shape: `{sales,revenue,refunds,cost,gross_profit,profit,profit_margin,orders,units,aov,refund_rate,coverage,unknown_revenue,known_revenue,platform_fee,packaging_fee,logistics_fee,advertising_fee,unallocated_fees}`. Revenue = net sales; sales = paid merchandise revenue. Coverage is ratio. Orders/units counts numeric.

`GET /analytics`: shared filters. `{summary:Metrics,previous:Metrics,trend:[{date,...Metrics}],rows:[{id,name,channel_id?,store_id?,sku_id?,spec?,...Metrics}],total,page,page_size,anomalies:[{title,description,severity,target,filters}],breakdown:[{name,amount}],refund_reasons:[{name,value}],targets:[{store_id,name,month,target,actual,rate}],meta:{revision,as_of,filters}}`. Default group_by=channel. Aggregate before server pagination and sorting. Summary is whole filtered dataset, not displayed rows. Comparisons previous adjacent equal interval. Dedicated other endpoints may reuse this service.

`GET /orders`: shared filters → `{items:[{id,order_id,date,channel_id,channel_name,store_id,store_name,sku_id,name,spec,quantity,currency,original_amount,fx_rate,sales,refunds,cost,gross_profit,profit,platform_fee,packaging_fee,logistics_fee,advertising_fee,cost_source,cost_version_id,status}],total,page,page_size}`.

`GET /refunds`: filters + date_basis → `{items:[{id,date,order_id,line_id,name,store_name,channel_id,amount,reason,kind,quantity,recoverable_quantity,cost_reversal}],total,summary:{amount,orders,rate},reasons:[{name,value}],types:[{name,value}]}`. Refund-event basis rate=null.

`GET /costs`: filters + effective_date → `{items:[{id,sku_id,name,spec,channel_id,store_id,base_cost,unit_cost,source,version_id,effective_from,effective_to,previous_cost,change_rate,profit,profit_margin,coverage}],total,page,page_size,summary:{coverage,missing_count,rising_count,negative_count}}`.

`GET /costs/{sku_id}/history` → `{items:[{id,sku_id,scope,scope_id,unit_cost,effective_from,effective_to,note,created_at}]}`.

`POST /costs/preview`: `{sku_ids,scope:'base'|'channel'|'store',scope_id:'',unit_cost?,adjustment_type:'absolute'|'amount'|'percent',adjustment_value,effective_from,note,allow_zero?:false}` → `{preview_id,revision,changes:[...],summary:{affected_orders,old_profit,new_profit,profit_delta}}`. Store full preview for commit.

`POST /costs/simulate`: `{sku_ids,unit_cost,start,end,channel_ids?,store_ids?}` → `{affected_orders,old_profit,new_profit,profit_delta,old_margin,new_margin}`.

`POST /recalculations/preview`: `{sku_ids?,start,end,channel_ids?,store_ids?,only_missing:true}` → same preview shape. Recompute historical cost using effective versions; no implicit new current cost applied to older orders.

`POST /operations/commit`: `{preview_id,idempotency_key}` → `{operation_id,revision,summary}`. Cost and recalculation and mapping commits share this route. Stale preview →409. Same key different payload →409.

`GET /mappings` → `{items:[{id,store_id,platform_sku,sku_id,unit_factor,status}]}`. `POST /mappings/preview` `{mapping_id,sku_id,unit_factor}` → common preview. Historical remediation separate recalculation.

`GET /targets?month=2026-09` → `{items:[{store_id,name,month,target,actual,rate}]}`. `PUT /targets/{store_id}/{month}` `{target,idempotency_key}` → updated row.

`GET /reports/views` → `{items:[{id,name,report_type,filters,columns,sort}]}`. POST same fields to create; PATCH/DELETE `/{id}`.

`GET /reports/export?report_type=channels|stores|products|orders|refunds|costs|daily` plus shared filters → UTF8 BOM CSV whole filtered sorted results.

CSV agent owns: `GET /imports/templates` → `{items:[{name,label,fields}]}`; `GET /imports/templates/{name}` CSV; `POST /imports/preview` multipart `files` (canonical template filenames) → `{preview_id,revision,total_rows,new_count,duplicate_count,conflict_count,errors:[{file,row,field,message}],warnings:[],files:[]}`; `POST /imports/commit` `{preview_id,idempotency_key}` → result; `GET /imports/batches` → `{items:[]}`; `GET /imports/errors/{preview_id}` CSV.

`POST /demo/reset` `{confirm:true}`; `GET /health/live`, `GET /health/ready` (may also expose root `/health/*`).

Backend owns schema finalization; tell frontend and root immediately if changes needed. JSON OpenAPI should describe real output to generate shared types.
