import { useEffect, useState } from 'react';
import { Building2, DoorOpen, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, LandlordAPI } from '../../../api/client';
import type { Property, PropertyUnit } from '../../../types/landlord';
import { Button } from '../../ui/button';
import { FieldError, invalidFieldClass } from '../../ui/FieldError';
import { FieldLabel, FormDialog, fieldClass } from '../landlordUi';

export type EditTarget =
  | { kind: 'property'; property: Property }
  | { kind: 'unit'; unit: PropertyUnit; propertyName: string };

type Fields = { name?: string; address?: string; description?: string; unitNumber?: string };

/**
 * Edits a property (name, address, description) or a unit (its number) --
 * renovations, renumbering, a corrected address. Errors come from the server's
 * `fields` map and sit beside the field. Changing the address of a property
 * with booked jobs warns first: those vendors are told the location changed.
 */
export default function EditPortfolioDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: EditTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
}) {
  const [values, setValues] = useState<Fields>({});
  const [errors, setErrors] = useState<Fields>({});
  const [saving, setSaving] = useState(false);
  const [bookedJobs, setBookedJobs] = useState(0);

  useEffect(() => {
    setErrors({});
    setBookedJobs(0);
    if (!target) return;
    if (target.kind === 'property') {
      setValues({
        name: target.property.name,
        address: target.property.address,
        description: target.property.description || '',
      });
      // Only needed if they change the address, but cheap, and fetching up
      // front means the warning appears as they type rather than after a pause.
      LandlordAPI.propertyEditImpact(target.property._id)
        .then((response) => setBookedJobs((response.data as { bookedJobs: number })?.bookedJobs || 0))
        .catch(() => setBookedJobs(0));
    } else {
      setValues({ unitNumber: target.unit.unitNumber });
    }
  }, [target]);

  if (!target) return null;

  const isProperty = target.kind === 'property';
  const addressChanged =
    isProperty && (values.address || '').trim() !== (target.property.address || '').trim();

  const update = (key: keyof Fields) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [key]: event.target.value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const save = async () => {
    const local: Fields = {};
    if (isProperty) {
      if (!values.name?.trim()) local.name = 'Enter a property name.';
      if (!values.address?.trim()) local.address = "Enter the property's address.";
    } else if (!values.unitNumber?.trim()) {
      local.unitNumber = 'Enter a unit number.';
    }
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }

    setSaving(true);
    try {
      if (isProperty) {
        const response = await LandlordAPI.updateProperty(target.property._id, {
          name: values.name,
          address: values.address,
          description: values.description,
        });
        const notified = (response as { notifiedVendors?: number }).notifiedVendors || 0;
        // The vendors were emailed -- nothing on this screen shows that.
        if (notified > 0) toast.success(`${notified} vendor${notified === 1 ? ' was' : 's were'} told about the new address`);
      } else {
        await LandlordAPI.updateUnit(target.unit._id, { unitNumber: values.unitNumber || '' });
      }
      await onSaved();
    } catch (error) {
      const fields = error instanceof ApiError ? (error.payload as { fields?: Fields } | null)?.fields : null;
      if (fields) setErrors(fields);
      else toast.error(error instanceof Error ? error.message : 'Could not save your changes');
    } finally {
      setSaving(false);
    }
  };

  const input = (key: keyof Fields, label: string, placeholder: string, autoFocus = false) => (
    <div className="space-y-1.5">
      <label htmlFor={`edit-${key}`}>
        <FieldLabel>{label}</FieldLabel>
      </label>
      <input
        id={`edit-${key}`}
        data-testid={`edit-${key}`}
        autoFocus={autoFocus}
        className={`${fieldClass} ${errors[key] ? invalidFieldClass : ''}`}
        value={values[key] || ''}
        placeholder={placeholder}
        onChange={update(key)}
        aria-invalid={Boolean(errors[key])}
        aria-describedby={errors[key] ? `edit-${key}-error` : undefined}
      />
      <FieldError id={`edit-${key}-error`}>{errors[key]}</FieldError>
    </div>
  );

  return (
    <FormDialog
      open
      onOpenChange={(next) => (saving ? null : onOpenChange(next))}
      icon={isProperty ? Building2 : DoorOpen}
      title={isProperty ? 'Edit property' : 'Edit unit'}
      description={
        isProperty
          ? 'Changes show everywhere this property appears, including past jobs.'
          : `In ${target.propertyName}. Past jobs and tenants follow the new number.`
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {isProperty ? (
          <>
            {input('name', 'Name', 'e.g. Maple Court', true)}
            {input('address', 'Address', 'Street, city')}
            {addressChanged && bookedJobs > 0 ? (
              <div
                data-testid="edit-address-warning"
                className="flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {bookedJobs} booked job{bookedJobs === 1 ? '' : 's'} will see the new address. We'll email{' '}
                {bookedJobs === 1 ? 'that vendor' : 'those vendors'} to check their job page before heading out.
              </div>
            ) : null}
            <div className="space-y-1.5">
              <label htmlFor="edit-description">
                <FieldLabel>Description (optional)</FieldLabel>
              </label>
              <textarea
                id="edit-description"
                rows={3}
                className={`${fieldClass} h-auto py-2 ${errors.description ? invalidFieldClass : ''}`}
                value={values.description || ''}
                placeholder="Renovation notes, building details…"
                onChange={update('description')}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={errors.description ? 'edit-description-error' : undefined}
              />
              <FieldError id="edit-description-error">{errors.description}</FieldError>
            </div>
          </>
        ) : (
          input('unitNumber', 'Unit number', 'e.g. 101, A1, PH2', true)
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            className="border-slate-200"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" data-testid="edit-save" className="bg-[#137fec] hover:bg-[#137fec]/90" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
