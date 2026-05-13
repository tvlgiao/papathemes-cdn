(function(){"use strict";(function(i,{cartId:q="",minWarningFunc:g=(a,t,o)=>`<p class="cqc__alert">Minimum order quantity of '${a}' is ${t}.</p>`,maxWarningFunc:I=(a,t,o)=>`<p class="cqc__alert">Maximum order quantity of '${a}' is ${t}.</p>`,equalWarningFunc:C=(a,t,o,f)=>`<p class="cqc__alert" data-product-id="${f}">${a}: The quantity for ${t} bundle${t>1?"s":""} is ${o} items in total.</p>`,settings:u=window.PapathemesMultiQtyProductOptionsSettings||{}}={}){const a=i(`
        <style>
            .mqpo-addedToCartMsg-content .button--primary,
            .previewCartAction-checkout,
            .cart-actions,
            .cart-additionalCheckoutButtons {
                display: none !important;
            }

            .cqc__alert {
                font-weight: bold;
                color: #ff0000;
                text-align: center;
            }
        </style>
    `),t=()=>{a.appendTo("head");let o=!0;stencilUtils.api.cart.getCart({cartId:q},async(f,Q)=>{if(f||!Q){a.remove();return}i(".cqc__alert").remove();const _=Q.lineItems.physicalItems.reduce((r,e)=>({...r,[e.productId]:e.quantity+(r[e.productId]||0)}),{}),k=Object.entries(_).map(([r,e])=>new Promise(h=>{i.ajax({url:"/graphql",method:"POST",contentType:"application/json",data:JSON.stringify({query:`
                    query getProduct($entityId: Int!) {
                        site {
                            product(entityId: $entityId) {
                                name
                                customFields {
                                    edges {
                                        node {
                                            name
                                            value
                                        }
                                    }
                                }
                            }
                        }
                    }
                `,variables:{entityId:parseInt(r)}}),headers:{"Content-Type":"application/json",Authorization:`Bearer ${u.graphQLToken}`},xhrFields:{withCredentials:!0},success:n=>{if(!n||!n.data||!n.data.site||!n.data.site.product)return h();const c=n.data.site.product,m=c.name;let p=0,y=0,s=0;if(c.customFields&&c.customFields.edges&&c.customFields.edges.forEach(d=>{const l=d.node.name,w=parseInt(d.node.value,10)||0;l===u.minQtyCustomFieldName?p=w:l===u.maxQtyCustomFieldName?y=w:l===u.equalQtyCustomFieldName&&(s=w)}),p>0&&e<p)o=!1,i(g(m,p,r)).insertAfter("[data-cart-page-title]");else if(y>0&&e>y)o=!1,i(I(m,y,r)).insertAfter("[data-cart-page-title]");else if(s>0&&e>0&&e%s!==0){o=!1;const d=e<s?1:Math.ceil(e/s),l=d*s;i(C(m,d,l,r)).insertAfter("[data-cart-page-title]")}h()},error:(n,c,m)=>{h()}})}));await Promise.all(k),o&&(a.remove(),i(".cqc__alert").remove())})};i(document).ready(()=>t()),stencilUtils.hooks.on("cart-item-add-remote",()=>t()),stencilUtils.hooks.on("cart-item-update-remote",()=>t()),stencilUtils.hooks.on("cart-item-remove-remote",()=>t())})(window.jQueryTheme||window.jQuerySupermarket||window.chiarajQuery||window.jQuery,{...window.PapathemesMultiQtyProductOptionsSettings,...window.PapathemesMultiQtyProductOptionsSettings.cartQtyCheckConfig})})();
