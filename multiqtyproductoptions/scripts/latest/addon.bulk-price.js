(function(){"use strict";var O,j;function E(){if(j)return O;j=1;function e(r,t,l){var n,i,c,a,d;t==null&&(t=100);function o(){var _=Date.now()-a;_<t&&_>=0?n=setTimeout(o,t-_):(n=null,l||(d=r.apply(c,i),c=i=null))}var m=function(){c=this,i=arguments,a=Date.now();var _=l&&!n;return n||(n=setTimeout(o,t)),_&&(d=r.apply(c,i),c=i=null),d};return m.clear=function(){n&&(clearTimeout(n),n=null)},m.flush=function(){n&&(d=r.apply(c,i),c=i=null,clearTimeout(n),n=null)},m}return e.debounce=e,O=e,O}var L=E();function U(e,r=2,t=".",l=","){try{let n=Math.abs(r);n=Number.isNaN(n)?2:n;const i=e<0?"-":"",c=Math.abs(Number(e)||0).toFixed(n),a=parseInt(c,10).toString(),d=a.length>3?a.length%3:0;return i+(d?a.substr(0,d)+l:"")+a.substr(d).replace(/(\d{3})(?=\d)/g,`$1${l}`)+(n?t+Math.abs(c-a).toFixed(n).slice(2):"")}catch{return null}}function R(e,{currency_token:r="$",currency_location:t="left",decimal_token:l=".",decimal_places:n=2,thousands_token:i=","}={}){const c=U(e,n,l,i);return t.toLowerCase()==="left"?`${r}${c}`:`${c}${r}`}function G(e,r={currency_token:"$",currency_location:"left",decimal_token:".",decimal_places:2,thousands_token:",",value:0}){const t={...r};if(!e&&e!==0)return t;const l=String(e).trim().match(/^([^0-9]*)([0-9.,]*)([^0-9]*)$/),n=String(l[1]).trim(),i=String(l[2]),c=String(l[3]).trim(),a=i.indexOf(","),d=(i.match(/,/g)||[]).length,o=i.indexOf("."),m=(i.match(/\./g)||[]).length;return n?(t.currency_token=n,t.currency_location="left"):c&&(t.currency_token=c,t.currency_location="right"),d.length>=2?(t.thousands_token=",",t.decimal_token=".",t.decimal_places=o>-1?i.length-o-1:0):m.length>=2?(t.thousands_token=".",t.decimal_token=",",t.decimal_places=a>-1?i.length-a-1:0):a>o&&o>-1?(t.thousands_token=".",t.decimal_token=",",t.decimal_places=i.length-a-1):o>a&&a>-1?(t.thousands_token=",",t.decimal_token=".",t.decimal_places=i.length-o-1):a>-1?(i.length-a-1)%3===0?(t.thousands_token=",",t.decimal_token=".",t.decimal_places=0):(t.thousands_token=".",t.decimal_token=",",t.decimal_places=i.length-a-1):o>-1?(i.length-o-1)%3===0?(t.thousands_token=".",t.decimal_token=",",t.decimal_places=0):(t.thousands_token=",",t.decimal_token=".",t.decimal_places=i.length-o-1):a===-1&&o===-1&&(t.decimal_places=0),t.value=Number(i.split(t.thousands_token).join("").split(t.decimal_token).join(".")),t}function B(e){return Number(e.split(" - ")[0].replace(/[^0-9.-]/g,""))}function h(e,r){const t=G(r);return R(e,t)}(function(e,{cartId:r="",graphQLToken:t="",formSelector:l=".form[data-cart-item-add]",productViewSelector:n=".productView",productViewPriceSelector:i=".productView-price",priceWithTaxSelector:c="[data-product-price-with-tax]",priceWithoutTaxSelector:a="[data-product-price-without-tax]",bulkPricingText:d=`
        <div class="_rows">
            <div class="price-section-group _withTax">
                <span class="_tax"><abbr title="Including Tax">Inc. GST</abbr></span>
                <span class="_stdPrice"><span class="_label">Price </span>{stdPriceWithTax}</span>
                <span class="_discount"><span class="_label">Discount applied </span>{discountWithTax} Off</span>
                <span class="_unitPrice"><span class="_label">Price </span>{priceWithTax}</span>
                <span class="_total"><span class="_label">Total </span>{totalWithTax}</span>
            </div>
            <div class="price-section-group _withoutTax">
                <span class="_tax"><abbr title="Excluding Tax">Ex. GST</abbr></span>
                <span class="_stdPrice"><span class="_label">Price </span>{stdPriceWithoutTax}</span>
                <span class="_discount"><span class="_label">Discount applied </span>{discountWithoutTax} Off</span>
                <span class="_unitPrice"><span class="_label">Price </span>{priceWithoutTax}</span>
                <span class="_total"><span class="_label">Total </span>{totalWithoutTax}</span>
            </div>
        </div>
    `,addBulkPricingElementFunc:o=(m,_,V)=>V.after(m)}={}){const m={};e(()=>{e("<style></style>").html(`
            .mqpo__productView-bulkPricing-price {
                font-weight: 700;
            }
            .mqpo__productView-bulkPricing-price ._rows {
                display: grid;
                grid-template-columns: 100%;
                gap: .75rem;
            }
            .mqpo__productView-bulkPricing-price ._withTax,
            .mqpo__productView-bulkPricing-price ._withoutTax {
                display: grid;
                grid-template-columns: 1fr 1fr max-content 1fr 1fr;
                gap: .75rem;
            }
            .mqpo__productView-bulkPricing-price ._label {
                color: #999;
                font-weight: normal;
                display: block;
            }
        `).appendTo("head");const _=()=>{const f=[];e(l).not(`.${APPUID}BulkPriceLoaded`).each((T,k)=>{const u=e(k).addClass(`${APPUID}BulkPriceLoaded`),w=Number(u.find('input[name="product_id"]').val());w&&f.push(w)}),f.length!==0&&e.ajax({url:"/graphql",method:"POST",data:JSON.stringify({query:`
                        query {
                            site {
                                products(entityIds: ${JSON.stringify(f)}, first: ${f.length}) {
                                    edges {
                                        node {
                                            entityId
                                            prices {
                                                price {
                                                    currencyCode
                                                    value
                                                }
                                                salePrice {
                                                    currencyCode
                                                    value
                                                }
                                                basePrice {
                                                    currencyCode
                                                    value
                                                }
                                                priceRange {
                                                    min {
                                                        currencyCode
                                                        value
                                                    }
                                                    max {
                                                        currencyCode
                                                        value
                                                    }
                                                }
                                                bulkPricing {
                                                    minimumQuantity
                                                    maximumQuantity
                                                    ... on BulkPricingFixedPriceDiscount {
                                                        price
                                                    }
                                                    ... on BulkPricingPercentageDiscount {
                                                        percentOff
                                                    }
                                                    ... on BulkPricingRelativePriceDiscount {
                                                        priceAdjustment
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                            }
                        }
                    `}),headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},xhrFields:{withCredentials:!0},success:function(T){Object.assign(m,T.data.site.products.edges.reduce((k,{node:u})=>({...k,[u.entityId]:u.prices.bulkPricing}),{}))}})},V=f=>{const T=f.find("[data-mqpo-quantity-change] input").not(":disabled, :hidden").get().reduce((p,s)=>p+(Number(e(s).val())||0),0),k=Number(f.find("[data-quantity-change] input").not(":disabled, :hidden").val())||1,u=T*k,w=Number(f.find('input[name="product_id"]').val()),M=m[w],A=e(`input[name="product_id"][value="${w}"]`).closest(n),N=A.find(i).first().show();let P=A.find(`[data-${APPUID_DASHCASE}-bulk-pricing-price]`);if(P.length===0&&(P=e(`<div data-${APPUID_DASHCASE}-bulk-pricing-price class="mqpo__productView-bulkPricing-price"></div>`),o(P,A,N)),P.html(""),u<=1){P.hide(),N.show();return}const C=f.find("[data-mqpo-quantity-change] input").not(":disabled, :hidden").filter((p,s)=>Number(e(s).val())>0).get(),H=C.reduce((p,s)=>p+(B(e(s).closest("[data-mqpo-attribute-item]").find("[data-mqpo-price-with-tax]").text())||0)*Number(e(s).val()),0),J=C.reduce((p,s)=>p+(B(e(s).closest("[data-mqpo-attribute-item]").find("[data-mqpo-price-without-tax]").text())||0)*Number(e(s).val()),0),v=C.reduce((p,s)=>e(s).closest("[data-mqpo-attribute-item]").find("[data-mqpo-price-with-tax]").text().trim()||p,""),W=C.reduce((p,s)=>e(s).closest("[data-mqpo-attribute-item]").find("[data-mqpo-price-without-tax]").text().trim()||p,""),q=H/u,S=J/u;if(!q&&!S){P.hide(),N.show();return}const{priceOff:y,percentOff:g,priceAdjustment:x}=M?M.reduce((p,{minimumQuantity:s,maximumQuantity:F,...X})=>u>=s&&(!F||u<=F)?{...X}:p,{}):{},I=y||(g?q*(100-g)/100:x?q-x:q),D=y||(g?S*(100-g)/100:x?S-x:S),z=h(I,v),K=h(D,W),Q=y?h(y,v):g?`${g}%`:x?h(-x,v):"",$=y?h(y,W):g?`${g}%`:x?h(-x,W):"",b=e(d);b.html(b.html().replace("{qty}",u).replace("{stdPriceWithTax}",h(q,v)).replace("{discountWithTax}",Q).replace("{priceWithTax}",z).replace("{totalWithTax}",h(I*u,v)).replace("{stdPriceWithoutTax}",h(S,W)).replace("{discountWithoutTax}",$).replace("{priceWithoutTax}",K).replace("{totalWithoutTax}",h(D*u,W))),I||b.find("._withTax").hide(),D||b.find("._withoutTax").hide(),Q?b.find("._withTax").find("._discount, ._unitPrice").show():b.find("._withTax").find("._discount, ._unitPrice").hide(),$?b.find("._withoutTax").find("._discount, ._unitPrice").show():b.find("._withoutTax").find("._discount, ._unitPrice").hide(),(I||D)&&(P.append(b).show(),N.hide())};new MutationObserver(L.debounce(_,300)).observe(document.body,{childList:!0,subtree:!0}),_(),e("body").on("itemupdated.mqpo",(f,T)=>{V(T.$scope)})})})(window.jQueryTheme,{...window.PapathemesMultiQtyProductOptionsSettings,...window.PapathemesMultiQtyProductOptionsSettings.bulkPriceConfig})})();
