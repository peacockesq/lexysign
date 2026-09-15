import { useState } from "react";
import RecipientList from "./RecipientList";
// import { Tooltip } from "react-tooltip";
import { useTranslation } from "react-i18next";

function SignerListPlace(props) {
  const { t } = useTranslation();

  const handleAddRecipient = () => {
    props?.setIsAddSigner(true);
    props.setIsTour && props.setIsTour(false);
  };

  return (
    <div>
      <div className="mx-2 pr-2 pt-2 pb-1 text-[15px] text-base-content font-semibold border-b-[1px] border-base-300 min-w-0">
        <span className="relative inline-flex items-center gap-1 min-w-0 max-w-full">
          {props.title ? props.title : "Recipients"}
          <sup onClick={() => props.setIsTour && props.setIsTour(true)} className="leading-none">
            <span className="inline-flex cursor-pointer rounded-full border border-base-content w-4 h-4 items-center justify-center text-[11px] font-bold leading-none" aria-label="Help">
              ?
            </span>
          </sup>
        </span>
      </div>
      <div className="overflow-auto hide-scrollbar max-h-[180px] min-w-0">
        <RecipientList
          {...props}
        />
      </div>
      <div className="mx-1">
        {props.handleAddSigner ? (
          <div
            role="button"
            data-tut="reactourAddbtn"
            disabled={props?.isMailSend ? true : false}
            className="op-btn op-btn-accent op-btn-outline w-full mt-[14px]"
            onClick={() => props.handleAddSigner()}
          >
            <i className="fa-light fa-plus"></i> {t("add-role")}
          </div>
        ) : (
          <div
            role="button"
            data-tut="addRecipient"
            className="op-btn op-btn-accent op-btn-outline w-full mt-[14px]"
            disabled={props?.isMailSend ? true : false}
            onClick={handleAddRecipient}
          >
            <i className="fa-light fa-plus"></i> {t("add-recipients")}
          </div>
        )}
      </div>
    </div>
  );
}

export default SignerListPlace;